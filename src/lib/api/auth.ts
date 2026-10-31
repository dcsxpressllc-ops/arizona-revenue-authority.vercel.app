import "server-only";

import type { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  bumpApiKeyLastUsed,
  findApiKeyByPrefix,
} from "@/lib/firestore/api-keys";
import {
  hashApiKey,
  parseApiKey,
  safeEqualHash,
} from "@/lib/api/keys";
import {
  apiError,
  apiOk,
  newRequestId,
  type ResponseMeta,
} from "@/lib/api/responses";
import {
  LATEST_API_VERSION,
  resolveVersion,
} from "@/lib/api/versions";
import {
  fingerprintRequest,
  isValidIdempotencyKey,
  readIdempotencyCache,
  writeIdempotencyCache,
} from "@/lib/api/idempotency";
import {
  checkAndCount as checkRateLimit,
  snapshotRemaining,
} from "@/lib/api/rate-limit";
import { captureRequestLog } from "@/lib/api/logs";
import type { ApiKeyMode, ApiKeyScope } from "@/types/api";
import { runAfterResponse } from "@/lib/server/after-response";

/**
 * Public API request lifecycle: auth, version resolve, optional idempotency,
 * handler, response capture.
 *
 * `authenticateApiRequest` is the low-level entry (context or an error
 * response); `withApiAuth` wraps auth, body parsing, idempotency and headers
 * and is what most routes should use.
 *
 * Tenancy: these routes run on the Admin SDK, outside Firestore rules, so
 * tenancy is enforced in code. Every write must stamp ctx.agencyId and
 * ctx.subAccountId, and reads must check doc.subAccountId against the ctx.
 * Forgetting means a cross-tenant leak.
 */

export interface ApiAuthContext extends ResponseMeta {
  agencyId: string;
  subAccountId: string;
  keyId: string;
  /** First 8 chars of the key. Safe to log. */
  keyPrefix: string;
  mode: ApiKeyMode;
  scopes: ApiKeyScope[];
}

export interface WithApiAuthOptions {
  /** Defaults to "admin". */
  requireScope?: ApiKeyScope;
  /**
   * By default we cache POST/PATCH/DELETE when an Idempotency-Key header is
   * present. `false` forces a skip (e.g. an admin endpoint that must always re-run).
   */
  idempotency?: boolean;
}

export interface ApiHandlerInput<P extends Record<string, string> = Record<string, string>> {
  request: Request;
  params: P;
  /** null when the body is empty or not JSON. */
  body: unknown;
  /** Used for idempotency fingerprinting. */
  rawBody: string;
  ctx: ApiAuthContext;
}

const METHODS_WITH_IDEMPOTENCY = new Set(["POST", "PATCH", "DELETE", "PUT"]);

function readBearerToken(request: Request): string | null {
  const authz = request.headers.get("authorization") ?? "";
  const trimmed = authz.trim();
  if (!trimmed) return null;
  // Case-insensitive "Bearer", like Stripe.
  const m = /^Bearer\s+(.+)$/i.exec(trimmed);
  if (!m) return null;
  return m[1]!.trim();
}

/** Auth + version resolve. Bumps lastUsedAt fire-and-forget on success. */
export async function authenticateApiRequest(
  request: Request,
): Promise<ApiAuthContext | NextResponse> {
  const requestId = newRequestId();
  // Seed meta with the latest version so even a rejection for a bad version
  // header echoes a sane LeadStack-Version.
  const tentativeMeta: ResponseMeta = {
    requestId,
    apiVersion: LATEST_API_VERSION,
  };

  const token = readBearerToken(request);
  if (!token) {
    return apiError(
      tentativeMeta,
      "authentication_error",
      "missing_api_key",
      "No API key provided. Pass it via the Authorization header as 'Bearer <key>'.",
    );
  }

  const parsed = parseApiKey(token);
  if (!parsed) {
    return apiError(
      tentativeMeta,
      "authentication_error",
      "malformed_api_key",
      "The API key is malformed. Keys must look like 'lsk_live_<8>_<32>' or 'lsk_test_<8>_<32>'.",
    );
  }

  const candidate = await findApiKeyByPrefix(parsed.prefix);
  if (!candidate || candidate.mode !== parsed.mode) {
    // Unknown prefix or mode mismatch (e.g. "live" swapped for "test" in a
    // captured key). Same message either way so callers can't tell which.
    return apiError(
      tentativeMeta,
      "authentication_error",
      "invalid_api_key",
      "Invalid API key provided.",
    );
  }

  // Constant-time compare before the lastUsedAt bump so timing can't reveal
  // whether a key exists.
  const expected = candidate.hashedSecret;
  const actual = hashApiKey(token);
  if (!safeEqualHash(expected, actual)) {
    return apiError(
      tentativeMeta,
      "authentication_error",
      "invalid_api_key",
      "Invalid API key provided.",
    );
  }

  if (candidate.revokedAt) {
    return apiError(
      tentativeMeta,
      "authentication_error",
      "revoked_api_key",
      "This API key has been revoked. Mint a new one from Settings → API keys.",
    );
  }

  // Agency kill-switch: apiAccessEnabledByAgency blocks every /api/v1 request for
  // the sub-account without revoking keys. Costs one read per request. Missing
  // field means denied.
  const subSnap = await getAdminDb()
    .doc(`subAccounts/${candidate.subAccountId}`)
    .get();
  if (!subSnap.exists) {
    return apiError(
      tentativeMeta,
      "authentication_error",
      "invalid_api_key",
      "Invalid API key provided.",
    );
  }
  const subData = subSnap.data()!;
  if (subData.apiAccessEnabledByAgency !== true) {
    return apiError(
      tentativeMeta,
      "permission_error",
      "api_access_disabled",
      "API access has been disabled for this sub-account by your agency administrator. Contact them to re-enable.",
    );
  }

  // Header pin, then key default, then latest.
  const headerVersion = request.headers.get("leadstack-version");
  const resolved = resolveVersion({
    headerVersion: headerVersion ?? null,
    keyDefaultVersion: candidate.defaultVersion ?? null,
  });
  if ("error" in resolved) {
    return apiError(
      tentativeMeta,
      "invalid_request",
      "unsupported_version",
      resolved.error,
    );
  }

  runAfterResponse(() =>
    bumpApiKeyLastUsed(candidate.subAccountId, candidate.id).catch((err) => {
      console.warn("[api/auth] bumpApiKeyLastUsed failed", err);
    }),
  );

  return {
    agencyId: candidate.agencyId,
    subAccountId: candidate.subAccountId,
    keyId: candidate.id,
    keyPrefix: candidate.prefix,
    mode: candidate.mode,
    scopes: candidate.scopes,
    requestId,
    apiVersion: resolved.version,
  };
}

/** Returns a denial response, or null. For routes that call `authenticateApiRequest` directly. */
export function requireApiScope(
  ctx: ApiAuthContext,
  scope: ApiKeyScope,
): NextResponse | null {
  if (ctx.scopes.includes(scope)) return null;
  return apiError(
    ctx,
    "permission_error",
    "insufficient_scope",
    `This key is missing required scope '${scope}'. Mint a new key with the right scope.`,
  );
}

/**
 * Read the body exactly once. `body` is null when empty or not JSON. Both forms
 * go to the handler so nothing re-consumes the stream.
 */
async function readBody(
  request: Request,
): Promise<{ rawBody: string; body: unknown }> {
  if (request.method === "GET" || request.method === "HEAD") {
    return { rawBody: "", body: null };
  }
  const rawBody = await request.text();
  if (!rawBody) return { rawBody: "", body: null };
  try {
    return { rawBody, body: JSON.parse(rawBody) };
  } catch {
    return { rawBody, body: null };
  }
}

/**
 * Wraps auth, body parsing, scope check, rate limit, idempotency and response
 * headers. Use for nearly every v1 route:
 *
 *   export const POST = withApiAuth<{ id: string }>(async ({ ctx, params, body }) => {
 *     return apiOk(ctx, { contact: serializeContactForApi(c) }, { status: 201 });
 *   }, { requireScope: "admin" });
 */
export function withApiAuth<P extends Record<string, string> = Record<string, string>>(
  handler: (input: ApiHandlerInput<P>) => Promise<NextResponse>,
  opts: WithApiAuthOptions = {},
): (
  request: Request,
  routeCtx: { params: Promise<P> },
) => Promise<NextResponse> {
  const requireScope: ApiKeyScope = opts.requireScope ?? "admin";

  return async (request, routeCtx) => {
    const start = Date.now();
    const url = new URL(request.url);

    const ctxOrErr = await authenticateApiRequest(request);
    if (!isAuthContext(ctxOrErr)) {
      // No ctx means we don't know which sub-account to log under. The 401 is the record.
      return ctxOrErr;
    }
    const ctx = ctxOrErr;

    // Read the body up front: every exit below needs it for the log capture.
    // GET/HEAD short-circuit in readBody.
    const params = await routeCtx.params;
    const { rawBody, body } = await readBody(request);

    // Every exit goes through here so each request lands in the log viewer.
    const finalize = async (
      response: NextResponse,
      preReadBody?: unknown,
      errorCode?: string | null,
    ): Promise<NextResponse> => {
      const bodyJson =
        preReadBody !== undefined
          ? preReadBody
          : await response
              .clone()
              .json()
              .catch(() => null);
      runAfterResponse(() => captureRequestLog({
        subAccountId: ctx.subAccountId,
        agencyId: ctx.agencyId,
        keyId: ctx.keyId,
        keyPrefix: ctx.keyPrefix,
        mode: ctx.mode,
        requestId: ctx.requestId,
        method: request.method,
        path: url.pathname,
        query: url.search,
        requestHeaders: request.headers,
        requestBody: rawBody,
        responseStatus: response.status,
        responseBodyJson: bodyJson,
        errorCode: errorCode ?? null,
        latencyMs: Date.now() - start,
      }));
      return response;
    };

    const scopeErr = requireApiScope(ctx, requireScope);
    if (scopeErr) return finalize(scopeErr, undefined, "insufficient_scope");

    // After auth + scope so failed-auth requests don't burn the caller's budget.
    const rl = checkRateLimit({
      keyId: ctx.keyId,
      mode: ctx.mode,
      scope: requireScope,
    });
    if (!rl.ok) {
      const rlResp = apiError(
        ctx,
        "rate_limit_error",
        "rate_limited",
        `Too many requests. Retry after ${rl.retryAfterSec}s.`,
        {
          extraHeaders: {
            "Retry-After": String(rl.retryAfterSec),
            "X-RateLimit-Limit": String(rl.limit ?? 0),
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": String(rl.retryAfterSec),
            "X-RateLimit-Window": rl.window ?? "",
          },
        },
      );
      return finalize(rlResp, undefined, "rate_limited");
    }

    const idempotencyKey = request.headers.get("idempotency-key");
    const useIdempotency =
      opts.idempotency !== false &&
      METHODS_WITH_IDEMPOTENCY.has(request.method) &&
      !!idempotencyKey;

    let fingerprint: string | null = null;
    if (useIdempotency) {
      if (!isValidIdempotencyKey(idempotencyKey!)) {
        return finalize(
          apiError(
            ctx,
            "invalid_request",
            "invalid_idempotency_key",
            "Idempotency-Key must be 1-255 characters of [A-Za-z0-9_-:.].",
          ),
          undefined,
          "invalid_idempotency_key",
        );
      }
      fingerprint = fingerprintRequest(request.method, url.pathname, rawBody);
      const cached = await readIdempotencyCache(
        ctx.subAccountId,
        ctx.mode,
        ctx.keyId,
        idempotencyKey!,
      );
      if (cached) {
        if (cached.requestFingerprint !== fingerprint) {
          return finalize(
            apiError(
              ctx,
              "idempotency_error",
              "idempotency_collision",
              "This Idempotency-Key was already used with a different request body. Use a new key for a new request.",
            ),
            undefined,
            "idempotency_collision",
          );
        }
        return finalize(
          apiOk(ctx, cached.bodyJson, { status: cached.status }),
          cached.bodyJson,
        );
      }
    }

    let response: NextResponse;
    try {
      response = await handler({ request, params, body, rawBody, ctx });
    } catch (err) {
      console.error("[api/v1] handler threw", err);
      return finalize(
        apiError(
          ctx,
          "internal_error",
          "internal_error",
          "Something went wrong on our end. Quote this request_id in support.",
        ),
        undefined,
        "internal_error",
      );
    }

    // Read once so the idempotency cache and log capture see the same bytes.
    const responseBodyJson = await response
      .clone()
      .json()
      .catch(() => null);

    // Never cache 5xx, so a retry with the same key actually re-runs the handler.
    if (useIdempotency && fingerprint && response.status < 500) {
      try {
        await writeIdempotencyCache(
          ctx.subAccountId,
          ctx.mode,
          ctx.keyId,
          idempotencyKey!,
          {
            status: response.status,
            bodyJson: responseBodyJson,
            requestFingerprint: fingerprint,
          },
        );
      } catch (err) {
        // Don't fail the response over a cache write. Worst case the next retry re-runs.
        console.warn("[api/v1] idempotency cache write failed", err);
      }
    }

    // Rate-limit headers so clients can pace themselves before a 429. Computed after
    // counting, so `remaining` is post-increment.
    const snapshot = snapshotRemaining({
      keyId: ctx.keyId,
      mode: ctx.mode,
      scope: requireScope,
    });
    response.headers.set("X-RateLimit-Limit", String(snapshot.limit));
    response.headers.set("X-RateLimit-Remaining", String(snapshot.remaining));
    response.headers.set("X-RateLimit-Reset", String(snapshot.resetSec));

    return finalize(response, responseBodyJson);
  };
}

function isAuthContext(v: ApiAuthContext | NextResponse): v is ApiAuthContext {
  return typeof (v as ApiAuthContext).keyId === "string";
}
