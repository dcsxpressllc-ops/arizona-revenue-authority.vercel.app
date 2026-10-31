import { NextResponse } from "next/server";
import { getCommunityGate } from "@/lib/community/gate";
import { groupHomePath } from "@/lib/community/group-mode";
import {
  signMemberSessionToken,
  verifyMemberMagicLinkToken,
} from "@/lib/community/member-auth";
import { ensureMember } from "@/lib/community/member-account";
import { setMemberSessionCookie } from "@/lib/community/member-session";
import {
  getGroupById,
  joinGroupServerSide,
} from "@/lib/server/community-service";

export const dynamic = "force-dynamic";

/**
 * Exchange a magic-link token for a 30-day session cookie, creating the member
 * and reconciling a contact if needed. GET so the email link works in one tap.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ saId: string }> },
) {
  const { saId } = await params;
  const url = new URL(request.url);
  const loginUrl = (error: string) =>
    NextResponse.redirect(new URL(`/c/${saId}/login?error=${error}`, url));

  const gate = await getCommunityGate(saId);
  if (!gate || !gate.enabled) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const token = url.searchParams.get("token");
  if (!token) return loginUrl("missing_token");

  const verified = verifyMemberMagicLinkToken(token);
  if (!verified || verified.subAccountId !== saId) return loginUrl("expired");

  let memberId: string;
  try {
    const member = await ensureMember({
      subAccountId: saId,
      email: verified.email,
    });
    if (member.status !== "active") return loginUrl("inactive");
    memberId = member.id;
  } catch (err) {
    console.error("[community/login/verify] ensureMember failed", err);
    return loginUrl("error");
  }

  const sessionToken = signMemberSessionToken(saId, memberId, verified.email);
  await setMemberSessionCookie(sessionToken);

  // Finish a pending join now so they land inside the group, not on the join page.
  if (verified.joinGroupId) {
    const group = await getGroupById(saId, verified.joinGroupId);
    if (group && group.status === "published") {
      try {
        const outcome = await joinGroupServerSide({
          subAccountId: saId,
          agencyId: gate.agencyId,
          groupId: group.id,
          memberId,
        });
        if (outcome.status === "active" || outcome.status === "already") {
          return NextResponse.redirect(
            new URL(groupHomePath(saId, group), url),
          );
        }
      } catch (err) {
        console.error("[community/login/verify] auto-join failed", err);
      }
      // Approval, paid or error: send them to the group's About page.
      return NextResponse.redirect(new URL(`/c/${saId}/${group.slug}`, url));
    }
  }

  return NextResponse.redirect(new URL(`/c/${saId}`, url));
}
