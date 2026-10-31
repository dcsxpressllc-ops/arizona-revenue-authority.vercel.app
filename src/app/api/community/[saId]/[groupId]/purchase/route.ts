import { NextResponse } from "next/server";
import { getCommunityGate } from "@/lib/community/gate";
import { getCurrentMember } from "@/lib/community/member-session";
import { getGroupById, getMembership } from "@/lib/server/community-service";
import { requestPurchaseServerSide } from "@/lib/server/community-purchase-service";

export const dynamic = "force-dynamic";

/**
 * Start a one-time purchase for a group or a single course. Returns the
 * paypal.me URL; access is granted when staff mark it paid. Course purchases
 * need an active group membership, group purchases don't.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ saId: string; groupId: string }> },
) {
  const { saId, groupId } = await params;

  const gate = await getCommunityGate(saId);
  if (!gate || !gate.enabled) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const member = await getCurrentMember(saId);
  if (!member) {
    return NextResponse.json({ error: "Sign in first" }, { status: 401 });
  }
  const group = await getGroupById(saId, groupId);
  if (!group || group.status !== "published") {
    return NextResponse.json({ error: "Group not found" }, { status: 404 });
  }

  let body: { scope?: "group" | "course"; targetId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const scope = body.scope === "course" ? "course" : "group";
  const targetId = scope === "group" ? groupId : body.targetId;
  if (!targetId) {
    return NextResponse.json({ error: "Missing target" }, { status: 400 });
  }

  if (scope === "course") {
    const membership = await getMembership(saId, groupId, member.id);
    if (!membership || membership.status !== "active") {
      return NextResponse.json(
        { error: "Join the group first" },
        { status: 403 },
      );
    }
  }

  try {
    const result = await requestPurchaseServerSide({
      subAccountId: saId,
      groupId,
      memberId: member.id,
      scope,
      targetId,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Couldn't start purchase" },
      { status: 400 },
    );
  }
}
