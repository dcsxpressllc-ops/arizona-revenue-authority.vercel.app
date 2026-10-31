import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { buildInviteUrl } from "@/lib/server/members-service";

/**
 * Signup link for a pending invite ("Copy link"). Built server-side because
 * it carries the invite token. Same checks as DELETE.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string; inviteId: string }> },
) {
  const { id: subAccountId, inviteId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const snap = await getAdminDb().doc(`invites/${inviteId}`).get();
  const invite = snap.data();
  if (!snap.exists || !invite || invite.subAccountId !== subAccountId) {
    return NextResponse.json({ error: "Invite not found" }, { status: 404 });
  }
  if (invite.acceptedByUid || invite.revokedAt) {
    return NextResponse.json(
      { error: "This invite is no longer pending." },
      { status: 409 },
    );
  }
  return NextResponse.json({
    inviteUrl: buildInviteUrl(invite.email as string, inviteId),
  });
}

/**
 * Cancel a pending invite by stamping `revokedAt` (the members query filters
 * on it). Agency owner or sub-account admin, and the invite must belong to
 * this sub-account. Accepted invites return 409; use the members/[uid]
 * removal route instead.
 */
export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string; inviteId: string }> },
) {
  const { id: subAccountId, inviteId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const db = getAdminDb();
  const ref = db.doc(`invites/${inviteId}`);
  const snap = await ref.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Invite not found" }, { status: 404 });
  }

  const invite = snap.data() ?? {};
  if (invite.subAccountId !== subAccountId) {
    // Same 404 as a wrong id; don't reveal it exists elsewhere.
    return NextResponse.json({ error: "Invite not found" }, { status: 404 });
  }
  if (invite.acceptedByUid) {
    return NextResponse.json(
      {
        error:
          "Invite already accepted. Remove the member from the Members list instead.",
      },
      { status: 409 },
    );
  }
  if (invite.revokedAt) {
    return NextResponse.json({ ok: true, alreadyRevoked: true });
  }

  await ref.update({
    revokedAt: FieldValue.serverTimestamp(),
    revokedByUid: access.uid,
  });

  return NextResponse.json({ ok: true });
}
