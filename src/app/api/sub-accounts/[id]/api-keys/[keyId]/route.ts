import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { getApiKey, revokeApiKey } from "@/lib/firestore/api-keys";

/**
 * Revoke an API key. Idempotent (200 on an already-revoked key). The auth
 * middleware 401s revoked keys even if the hash matches.
 *
 * No PATCH: name and scopes are fixed at mint. Changing scope means mint a
 * new key and revoke the old one, same as Stripe, so permissions never
 * drift silently.
 */
export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string; keyId: string }> },
) {
  const { id: subAccountId, keyId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const doc = await getApiKey(subAccountId, keyId);
  if (!doc) {
    return NextResponse.json({ error: "Key not found" }, { status: 404 });
  }
  // Redundant with requireSubAccountAdmin, but catches the path param ever
  // drifting from the doc's stamped tenancy.
  if (doc.subAccountId !== subAccountId) {
    return NextResponse.json({ error: "Key not found" }, { status: 404 });
  }

  if (doc.revokedAt) {
    return NextResponse.json({ ok: true, alreadyRevoked: true });
  }

  await revokeApiKey(subAccountId, keyId, access.uid);
  return NextResponse.json({ ok: true });
}
