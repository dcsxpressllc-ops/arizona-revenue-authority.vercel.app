import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import {
  createInviteServerSide,
  MemberAddBlockedError,
  InviteSubAccountNotFoundError,
} from "@/lib/server/members-service";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Invite someone to a sub-account as admin or collaborator. Agency owner or
 * sub-account admin.
 *
 * New email: writes an `invites/{auto}` doc for the signup route to consume
 * and, with Resend configured, emails a /signup?email=<addr> link.
 * Existing account: adds them directly, emails an "added" notice, returns
 * `added: true`.
 *
 * A pending invite for the same (email, subAccountId) is reused and the
 * email re-sent, so this doubles as "resend". Without RESEND_API_KEY the
 * doc is still created and `mailed: false` tells the UI to offer the link.
 * The write lives in lib/server/members-service.ts (shared with the AI
 * Suite `invite_member` capability).
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: {
    email?: string;
    role?: "admin" | "collaborator";
    assignedTerritoryIds?: string[];
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const email = body.email?.trim().toLowerCase();
  if (!email || !EMAIL_RE.test(email)) {
    return NextResponse.json(
      { error: "Provide a valid email address." },
      { status: 400 },
    );
  }
  const role: "admin" | "collaborator" =
    body.role === "admin" ? "admin" : "collaborator";

  try {
    const res = await createInviteServerSide({
      subAccountId,
      invitedByUid: access.uid,
      email,
      role,
      assignedTerritoryIds: body.assignedTerritoryIds,
    });
    return NextResponse.json({
      ok: true,
      inviteId: res.inviteId,
      email: res.email,
      subAccountId: res.subAccountId,
      role: res.role,
      reused: res.reused,
      mailed: res.mailed,
      mailError: res.mailError,
      inviteUrl: res.inviteUrl,
      added: res.added,
      existing: res.existing,
      alreadyMember: res.alreadyMember,
    });
  } catch (err) {
    if (err instanceof MemberAddBlockedError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof InviteSubAccountNotFoundError) {
      return NextResponse.json(
        { error: "Sub-account not found" },
        { status: 404 },
      );
    }
    throw err;
  }
}
