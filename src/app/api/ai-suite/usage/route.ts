import "server-only";

import { NextResponse } from "next/server";
import {
  requireAgencyOwnerAny,
  requireSubAccountMember,
} from "@/lib/auth/require-tenancy";
import { getAdminDb } from "@/lib/firebase/admin";
import { readAiSuiteUsage } from "@/lib/ai-suite/usage";
import type { AiSuiteLevel } from "@/types/ai-suite";

export const dynamic = "force-dynamic";

/** Days from Jan 1 of the current year through today, inclusive (UTC). */
function daysSinceYearStart(): number {
  const now = new Date();
  const start = Date.UTC(now.getUTCFullYear(), 0, 1);
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  return Math.floor((today - start) / 86_400_000) + 1;
}

/** Year-to-date AI Suite usage for the activity grid. Same auth + gate as chat. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const level = url.searchParams.get("level") as AiSuiteLevel | null;
  const subAccountId = url.searchParams.get("subAccountId") ?? undefined;

  if (level !== "agency" && level !== "sub-account") {
    return NextResponse.json(
      { error: "`level` must be 'agency' or 'sub-account'." },
      { status: 400 },
    );
  }

  let agencyId = "";
  if (level === "sub-account") {
    if (!subAccountId) {
      return NextResponse.json(
        { error: "`subAccountId` is required for sub-account level." },
        { status: 400 },
      );
    }
    const access = await requireSubAccountMember(request, subAccountId);
    if (access instanceof NextResponse) return access;

    const subSnap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
    // Opt-in gate; unset reads as disabled, same as the chat route.
    if (subSnap.data()?.aiSuiteEnabledByAgency !== true) {
      return NextResponse.json(
        { error: "The AI Suite is disabled for this sub-account." },
        { status: 403 },
      );
    }
    agencyId = access.agencyId ?? "";
  } else {
    const owner = await requireAgencyOwnerAny(request);
    if (owner instanceof NextResponse) return owner;
    agencyId = owner.agencyId ?? "";
  }

  const days = await readAiSuiteUsage({
    level,
    agencyId,
    subAccountId,
    days: daysSinceYearStart(),
  });
  return NextResponse.json({ days });
}
