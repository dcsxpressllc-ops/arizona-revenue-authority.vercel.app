import "server-only";

import { getCommunityGate, type CommunityGate } from "@/lib/community/gate";
import { communityFeaturesOn } from "@/lib/community/group-mode";
import { getCurrentMember } from "@/lib/community/member-session";
import {
  getGroupById,
  getGroupBySlug,
  getMembership,
} from "@/lib/server/community-service";
import type {
  CommunityGroup,
  GroupMembership,
  Member,
} from "@/types/community";

export interface GroupAccessOk {
  kind: "ok";
  gate: CommunityGate;
  member: Member;
  group: CommunityGroup;
  membership: GroupMembership;
}

export type GroupPageAccess =
  | GroupAccessOk
  | { kind: "notFound" }
  | { kind: "redirect"; to: string };

/**
 * Member access to a group's gated pages (feed, classroom) by slug, for server
 * components: `notFound` (gate off / unpublished), `redirect` (to login, or to
 * About if signed in but not an active member), or `ok` with the context.
 */
export async function requireGroupPageAccess(
  saId: string,
  groupSlug: string,
): Promise<GroupPageAccess> {
  const gate = await getCommunityGate(saId);
  if (!gate || !gate.enabled) return { kind: "notFound" };

  const group = await getGroupBySlug(saId, groupSlug);
  if (!group || group.status !== "published") return { kind: "notFound" };

  const member = await getCurrentMember(saId);
  if (!member) {
    return {
      kind: "redirect",
      to: `/c/${saId}/login?next=${encodeURIComponent(`/c/${saId}/${groupSlug}`)}`,
    };
  }

  const membership = await getMembership(saId, group.id, member.id);
  if (!membership || membership.status !== "active") {
    // Not joined (or pending/removed): About page has the Join CTA.
    return { kind: "redirect", to: `/c/${saId}/${groupSlug}` };
  }

  return { kind: "ok", gate, member, group, membership };
}

/** Sub-account level, not group-scoped (DMs, profile). */
export type MemberApiAccess =
  | { kind: "ok"; gate: CommunityGate; member: Member }
  | { kind: "error"; status: number; message: string };

export async function requireMemberApi(
  saId: string,
): Promise<MemberApiAccess> {
  const gate = await getCommunityGate(saId);
  if (!gate || !gate.enabled) {
    return { kind: "error", status: 404, message: "Not found" };
  }
  const member = await getCurrentMember(saId);
  if (!member) {
    return { kind: "error", status: 401, message: "Sign in first" };
  }
  return { kind: "ok", gate, member };
}

export type GroupApiAccess =
  | GroupAccessOk
  | { kind: "error"; status: number; message: string };

/** Same check for member mutation routes, by groupId. Returns an error instead of redirecting. */
export async function requireGroupApiAccess(
  saId: string,
  groupId: string,
): Promise<GroupApiAccess> {
  const gate = await getCommunityGate(saId);
  if (!gate || !gate.enabled) {
    return { kind: "error", status: 404, message: "Not found" };
  }
  const member = await getCurrentMember(saId);
  if (!member) {
    return { kind: "error", status: 401, message: "Sign in first" };
  }
  const group = await getGroupById(saId, groupId);
  if (!group || group.status !== "published") {
    return { kind: "error", status: 404, message: "Group not found" };
  }
  const membership = await getMembership(saId, groupId, member.id);
  if (!membership || membership.status !== "active") {
    return { kind: "error", status: 403, message: "Join the group first" };
  }
  return { kind: "ok", gate, member, group, membership };
}

/** Also rejects courses-only groups: the feed pages redirect away, but the post/comment/like endpoints are reachable directly. */
export async function requireGroupFeedApiAccess(
  saId: string,
  groupId: string,
): Promise<GroupApiAccess> {
  const access = await requireGroupApiAccess(saId, groupId);
  if (access.kind === "ok" && !communityFeaturesOn(access.group)) {
    return {
      kind: "error",
      status: 403,
      message: "This group's community feed is disabled",
    };
  }
  return access;
}
