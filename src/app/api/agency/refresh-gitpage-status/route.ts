import "server-only";

import { NextResponse } from "next/server";
import { getAdminAuth, getAdminDb } from "@/lib/firebase/admin";
import {
  collectHeartbeatStats,
  markGitpageBuildSucceeded,
  sendHeartbeat,
} from "@/lib/gitpage/heartbeat";
import type { AgencyRole, MemberStatus } from "@/types";

/**
 * Owner-only on-demand gitpage heartbeat (Refresh button, tab refocus after
 * subscribing) instead of waiting for the daily cron. Returns the status so
 * the UI doesn't wait on Firestore.
 */
export async function POST(request: Request) {
  const uid = request.headers.get("x-user-uid");
  if (!uid) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const record = await getAdminAuth().getUser(uid);
  const claims = (record.customClaims ?? {}) as {
    agencyRole?: AgencyRole | null;
    status?: MemberStatus;
  };
  if (claims.status !== "active") {
    return NextResponse.json({ error: "Account inactive" }, { status: 403 });
  }
  if (claims.agencyRole !== "owner") {
    return NextResponse.json(
      { error: "Agency owner only" },
      { status: 403 },
    );
  }

  const stats = await collectHeartbeatStats();
  const result = await sendHeartbeat(stats);

  // If the heartbeat can't confirm (network error, or more often gitpage's
  // email lookup not matching the owner email we sent), fall back to: any
  // sub-account with a successful build in the last 7 days. That's stronger
  // evidence, e.g. a working key on a subscription under another email.
  const heartbeatConfirmed = result?.gitpageStatus?.agency === true;
  let backfilled = false;
  if (!heartbeatConfirmed) {
    try {
      const db = getAdminDb();
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const recent = await db
        .collectionGroup("website")
        .where("status", "==", "ready")
        .where("lastBuildAt", ">", sevenDaysAgo)
        .limit(1)
        .get();
      if (!recent.empty) {
        await markGitpageBuildSucceeded();
        backfilled = true;
      }
    } catch {
      // collectionGroup may need an index in prod; ignore
    }
  }

  return NextResponse.json({
    ok: true,
    sent: result !== null,
    agency: result?.gitpageStatus?.agency ?? null,
    backfilled,
  });
}
