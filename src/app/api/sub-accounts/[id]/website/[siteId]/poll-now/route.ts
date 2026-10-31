import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { GitpageError, pollBuild } from "@/lib/gitpage/client";
import { settleWebsiteBuild } from "@/lib/server/websites-service";
import { markGitpageKeyInvalid } from "@/lib/gitpage/heartbeat";
import { publishCallback, qstashIsConfigured } from "@/lib/automations/qstash";
import type { WebsiteDoc } from "@/types/website";

export const dynamic = "force-dynamic";

/**
 * Admin-only immediate poll of gitpage's status endpoint, bypassing QStash.
 * For a stalled chain (NEXT_PUBLIC_APP_URL mismatch, region drift, signing
 * keys) or a doc marked "failed" by the poll cap while gitpage kept building
 * (builds take 10-14 min); a re-check can bring it back to ready without a
 * rebuild.
 *
 * Same handling as /poll: settle ready/failed, 401 -> markGitpageKeyInvalid(),
 * 4xx -> failed, still running -> reset pollAttempts and start a fresh
 * chain. Returns the state so the UI needn't wait for Firestore.
 */

const POLL_INTERVAL_SECONDS = 20;

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string; siteId: string }> },
) {
  const { id: subAccountId, siteId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const db = getAdminDb();
  const docRef = db.doc(`subAccounts/${subAccountId}/website/${siteId}`);
  const snap = await docRef.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "No website doc." }, { status: 404 });
  }
  const websiteDoc = snap.data() as WebsiteDoc;

  // Queued/building is the normal stalled-chain case. "failed" with a gitpage
  // job id is re-checkable too: our 15-min cap may fire while gitpage still
  // finishes, and re-checking avoids spending a rebuild against its hourly cap.
  const recheckable =
    websiteDoc.status === "queued" ||
    websiteDoc.status === "building" ||
    (websiteDoc.status === "failed" && !!websiteDoc.gitpageJobId);
  if (!recheckable) {
    return NextResponse.json({
      ok: true,
      ignored: "not-in-flight",
      status: websiteDoc.status,
    });
  }

  const formResponseId = websiteDoc.gitpageJobId;
  if (!formResponseId) {
    return NextResponse.json(
      { error: "No gitpage job id on doc." },
      { status: 400 },
    );
  }

  let pollResult;
  try {
    pollResult = await pollBuild(formResponseId);
  } catch (err) {
    if (err instanceof GitpageError && err.status === 401) {
      await markGitpageKeyInvalid();
    }
    if (err instanceof GitpageError && err.status >= 400 && err.status < 500) {
      await docRef.update({
        status: "failed",
        errorMessage: `gitpage rejected the poll: ${err.message}`,
        updatedAt: FieldValue.serverTimestamp(),
      });
      return NextResponse.json({ ok: true, settled: "client-error" });
    }
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Poll request failed.",
      },
      { status: 502 },
    );
  }

  if (pollResult.isTerminal) {
    // Same settle path as the QStash tick and build.settled, so premium hand-off
    // runs here too.
    const settled = await settleWebsiteBuild({
      subAccountId,
      siteId,
      site: websiteDoc,
      result: pollResult,
      attempts: websiteDoc.pollAttempts ?? 0,
    });
    return NextResponse.json({
      ok: true,
      settled,
      ...(settled === "ready"
        ? { liveUrl: pollResult.pagesUrl }
        : { errorMessage: pollResult.error }),
    });
  }

  // Still running: reset pollAttempts for a fresh 15-min window and restart
  // the chain. A cap-timeout "failed" doc goes back to "building" and loses
  // its stale error.
  const nextStatus =
    pollResult.statusPhase && pollResult.statusPhase !== "processing"
      ? "building"
      : websiteDoc.status === "failed"
        ? "building"
        : websiteDoc.status;

  await docRef.update({
    status: nextStatus,
    errorMessage: null,
    pollAttempts: 0,
    updatedAt: FieldValue.serverTimestamp(),
  });

  let rescheduled = false;
  if (qstashIsConfigured()) {
    const result = await publishCallback({
      pathname: `/api/sub-accounts/${subAccountId}/website/${siteId}/poll`,
      body: { subAccountId, siteId, formResponseId },
      delaySeconds: POLL_INTERVAL_SECONDS,
      // Own dedup namespace + timestamp so it never collides with the original
      // chain.
      deduplicationId: `website_${subAccountId}_${siteId}_${formResponseId}_manual_${Date.now()}`,
    });
    rescheduled = result !== null;
  }

  return NextResponse.json({
    ok: true,
    deferred: "in-flight",
    status: nextStatus,
    statusPhase: pollResult.statusPhase,
    rescheduled,
  });
}
