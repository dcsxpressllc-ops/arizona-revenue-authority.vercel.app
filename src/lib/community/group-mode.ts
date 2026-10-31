import type { CommunityGroup, GroupMode } from "@/types/community";

/** Client-safe so the member shell, admin pages and guards share the default: no `mode` field = full community. */
export function groupMode(
  group: Pick<CommunityGroup, "mode">,
): GroupMode {
  return group.mode === "courses" ? "courses" : "community";
}

/** Feed / members / leaderboards are on (not courses-only). */
export function communityFeaturesOn(
  group: Pick<CommunityGroup, "mode">,
): boolean {
  return groupMode(group) === "community";
}

/** Feed for a full community, classroom for courses-only. */
export function groupHomePath(
  saId: string,
  group: Pick<CommunityGroup, "mode" | "slug">,
): string {
  return communityFeaturesOn(group)
    ? `/c/${saId}/${group.slug}/community`
    : `/c/${saId}/${group.slug}/classroom`;
}
