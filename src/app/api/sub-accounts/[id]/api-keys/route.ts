import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { hashApiKey, mintApiKey } from "@/lib/api/keys";
import { LATEST_API_VERSION } from "@/lib/api/versions";
import {
  createApiKey,
  docToResponse,
  listApiKeys,
} from "@/lib/firestore/api-keys";
import type { ApiKeyMode, ApiKeyScope } from "@/types/api";

/**
 * API keys for a sub-account.
 * GET: list keys (`?mode=live|test`, `?includeRevoked=1`), never the secret.
 * POST: mint { name, mode, scopes? }. The response is the only time the raw
 * `secret` is returned; the UI must show the "copy it now" banner.
 *
 * Sub-account admins only (agency owners count). A key can grant as much
 * as the caller's own session, or more.
 */

const VALID_SCOPES: ApiKeyScope[] = ["admin", "forms-ingest"];
const VALID_MODES: ApiKeyMode[] = ["live", "test"];
const MAX_NAME = 60;

interface CreateBody {
  name?: string;
  mode?: ApiKeyMode;
  scopes?: ApiKeyScope[];
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const url = new URL(request.url);
  const modeParam = url.searchParams.get("mode");
  const includeRevoked = url.searchParams.get("includeRevoked") === "1";

  const mode =
    modeParam && VALID_MODES.includes(modeParam as ApiKeyMode)
      ? (modeParam as ApiKeyMode)
      : undefined;

  const docs = await listApiKeys(subAccountId, { mode, includeRevoked });
  return NextResponse.json({ keys: docs.map(docToResponse) });
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: CreateBody;
  try {
    body = (await request.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const name = (body.name ?? "").trim();
  if (!name) {
    return NextResponse.json(
      { error: "Key name is required." },
      { status: 400 },
    );
  }
  if (name.length > MAX_NAME) {
    return NextResponse.json(
      { error: `Key name must be ${MAX_NAME} characters or fewer.` },
      { status: 400 },
    );
  }

  if (!body.mode || !VALID_MODES.includes(body.mode)) {
    return NextResponse.json(
      { error: "Mode must be 'live' or 'test'." },
      { status: 400 },
    );
  }

  const scopes: ApiKeyScope[] =
    Array.isArray(body.scopes) && body.scopes.length > 0
      ? body.scopes
      : ["admin"];
  for (const s of scopes) {
    if (!VALID_SCOPES.includes(s)) {
      return NextResponse.json(
        {
          error: `Unknown scope '${s}'. Allowed: ${VALID_SCOPES.join(", ")}.`,
        },
        { status: 400 },
      );
    }
  }
  // forms-ingest is a write-only, browser-safe (CORS) scope for one endpoint;
  // never mix it with admin.
  if (scopes.includes("forms-ingest") && scopes.includes("admin")) {
    return NextResponse.json(
      {
        error:
          "Cannot combine 'admin' and 'forms-ingest' on one key. Mint two keys instead.",
      },
      { status: 400 },
    );
  }

  // Only needed to denormalise agencyId onto the key doc.
  const subSnap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  if (!subSnap.exists) {
    return NextResponse.json(
      { error: "Sub-account not found" },
      { status: 404 },
    );
  }
  const subData = subSnap.data()!;
  const agencyId = (subData.agencyId as string) ?? "";
  if (!agencyId) {
    return NextResponse.json(
      { error: "Sub-account is missing agencyId" },
      { status: 500 },
    );
  }

  // Default-deny: the agency owner has to turn on API access first, so
  // sub-accounts without the field stay locked.
  if (subData.apiAccessEnabledByAgency !== true) {
    return NextResponse.json(
      {
        error:
          "API access is disabled for this sub-account. Your agency administrator can enable it from Manage in the agency sub-accounts list.",
      },
      { status: 403 },
    );
  }

  const minted = mintApiKey(body.mode);
  const doc = await createApiKey({
    subAccountId,
    agencyId,
    name,
    mode: body.mode,
    prefix: minted.prefix,
    hashedSecret: hashApiKey(minted.rawKey),
    scopes,
    // Pinned to the version live at mint time. Used when no `LeadStack-Version`
    // header is sent, so later breaking changes don't affect issued keys.
    defaultVersion: LATEST_API_VERSION,
    createdByUid: access.uid,
  });

  // The only response that includes the raw key.
  return NextResponse.json({
    key: { ...docToResponse(doc), secret: minted.rawKey },
  });
}
