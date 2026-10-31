import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";

/**
 * Agency gate for Webinar1. Opt-in: unset reads as off. Set via
 * `webinar1EnabledByAgency` on /api/agency/sub-accounts/[id]/feature-gates.
 */
export async function webinar1GateOn(subAccountId: string): Promise<boolean> {
  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  return snap.data()?.webinar1EnabledByAgency === true;
}

export function webinar1GateOffResponse(): NextResponse {
  return NextResponse.json(
    {
      error:
        "Webinars aren't enabled for this workspace. Ask your agency to turn them on.",
    },
    { status: 403 }
  );
}
