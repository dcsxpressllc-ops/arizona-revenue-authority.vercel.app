import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";

/**
 * Community admin routes: sub-account admin plus the agency's Community gate.
 * Returns the access context (with `agencyId` for writes) or a NextResponse.
 */
export async function requireCommunityStaff(
  request: Request,
  subAccountId: string,
) {
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;
  const subSnap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  const sub = subSnap.data();
  if (sub?.communityEnabledByAgency !== true) {
    return NextResponse.json(
      { error: "Community is disabled for this sub-account." },
      { status: 403 },
    );
  }
  return {
    ...access,
    resolvedAgencyId: (sub.agencyId as string) ?? access.agencyId ?? "",
  };
}
