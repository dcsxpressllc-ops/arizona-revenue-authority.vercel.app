import "server-only";

import { FieldValue, type Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import type { ApiKeyMode, ApiRequestLogResponse } from "@/types/api";

/**
 * Per-request capture for the public API into `apiRequestLogs/{logId}`.
 * `requestId` matches the X-Request-Id response header so a row can be found
 * from a support ticket. `mode` lets the viewer split live and test traffic.
 *
 * 30-day retention via `expiresAt`, swept by the daily api-cleanup cron. Writes are fire-and-forget from withApiAuth; a slow log write must
 * never delay the response.
 *
 * Authorization, cookies and other auth headers are dropped. Bodies are capped
 * at 2KB with a truncation marker.
 */

const BODY_EXCERPT_LIMIT = 2048;
const HEADERS_EXCERPT_LIMIT = 1024;
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

const REDACT_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-api-key",
  "leadstack-signature",
  "idempotency-key",
]);

export interface ApiRequestLogInput {
  subAccountId: string;
  agencyId: string;
  keyId: string;
  keyPrefix: string;
  mode: ApiKeyMode;
  requestId: string;
  method: string;
  path: string;
  query: string;
  requestHeaders: Headers;
  requestBody: string;
  responseStatus: number;
  responseBodyJson: unknown;
  errorCode: string | null;
  latencyMs: number;
}

function sanitizeHeaders(headers: Headers): string {
  const out: Record<string, string> = {};
  let bytes = 0;
  for (const [name, value] of headers.entries()) {
    if (REDACT_HEADERS.has(name.toLowerCase())) continue;
    const line = `${name}: ${value}`;
    if (bytes + line.length > HEADERS_EXCERPT_LIMIT) break;
    out[name] = value;
    bytes += line.length;
  }
  return JSON.stringify(out);
}

function truncate(input: string): string {
  if (input.length <= BODY_EXCERPT_LIMIT) return input;
  return `${input.slice(0, BODY_EXCERPT_LIMIT)}…(truncated, ${input.length} bytes)`;
}

function stringifyResponse(bodyJson: unknown): string {
  if (bodyJson === null || bodyJson === undefined) return "";
  try {
    return JSON.stringify(bodyJson);
  } catch {
    return "[unserializable]";
  }
}

/** Call with `void`, never await on the request path. Errors are logged, not thrown. */
export async function captureRequestLog(input: ApiRequestLogInput): Promise<void> {
  try {
    await getAdminDb()
      .collection("subAccounts")
      .doc(input.subAccountId)
      .collection("apiRequestLogs")
      .add({
        agencyId: input.agencyId,
        subAccountId: input.subAccountId,
        keyId: input.keyId,
        keyPrefix: input.keyPrefix,
        mode: input.mode,
        requestId: input.requestId,
        method: input.method,
        path: input.path,
        query: input.query,
        requestHeaders: sanitizeHeaders(input.requestHeaders),
        requestBody: truncate(input.requestBody),
        responseStatus: input.responseStatus,
        responseBody: truncate(stringifyResponse(input.responseBodyJson)),
        errorCode: input.errorCode,
        latencyMs: input.latencyMs,
        createdAt: FieldValue.serverTimestamp(),
        expiresAt: new Date(Date.now() + TTL_MS),
      });
  } catch (err) {
    console.warn("[api/logs] captureRequestLog failed", err);
  }
}

function tsToIso(ts: Timestamp | Date | null | undefined): string {
  if (!ts) return new Date(0).toISOString();
  if (ts instanceof Date) return ts.toISOString();
  if (typeof (ts as Timestamp).toDate === "function") {
    return (ts as Timestamp).toDate().toISOString();
  }
  return new Date(0).toISOString();
}

/**
 * Newest first. Orders by createdAt and filters `mode` in memory so no
 * composite index is needed. `limit` is clamped to [1, 200].
 */
export async function listRequestLogs(
  subAccountId: string,
  opts: { limit?: number } = {},
): Promise<ApiRequestLogResponse[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 200);
  const snap = await getAdminDb()
    .collection("subAccounts")
    .doc(subAccountId)
    .collection("apiRequestLogs")
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();
  return snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      requestId: (data.requestId as string) ?? "",
      mode: (data.mode as ApiKeyMode) ?? "live",
      keyPrefix: (data.keyPrefix as string) ?? "",
      method: (data.method as string) ?? "",
      path: (data.path as string) ?? "",
      query: (data.query as string) ?? "",
      responseStatus: (data.responseStatus as number) ?? 0,
      errorCode: (data.errorCode as string | null) ?? null,
      latencyMs: (data.latencyMs as number) ?? 0,
      createdAt: tsToIso(data.createdAt),
      requestHeaders: (data.requestHeaders as string) ?? "",
      requestBody: (data.requestBody as string) ?? "",
      responseBody: (data.responseBody as string) ?? "",
    };
  });
}
