import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";

/**
 * Agency gate for Community, same pattern as Broadcasts/Website/Social
 * Planner: strict `communityEnabledByAgency === true`. Must wrap every
 * community API route and every public /c/* page, not just the sidebar, so a
 * disabled group is unreachable by URL (pages notFound(), routes 403/404).
 */
export interface CommunityGate {
  subAccountId: string;
  agencyId: string;
  ownerUid: string;
  enabled: boolean;
}

export async function getCommunityGate(
  subAccountId: string,
): Promise<CommunityGate | null> {
  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  if (!snap.exists) return null;
  const data = snap.data()!;
  return {
    subAccountId,
    agencyId: (data.agencyId as string) ?? "",
    ownerUid: (data.createdByUid as string) ?? "",
    enabled: data.communityEnabledByAgency === true,
  };
}
