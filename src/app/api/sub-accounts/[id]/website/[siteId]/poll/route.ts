import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  publishCallback,
  qstashIsConfigured,
  verifyQStashSignature,
} from "@/lib/automations/qstash";
import { GitpageError, pollBuild } from "@/lib/gitpage/client";
import { markGitpageKeyInvalid } from "@/lib/gitpage/heartbeat";
import {
  pollAttemptCapFor,
  pollDelayFor,
  settleWebsiteBuild,
} from "@/lib/server/websites-service";
import type { WebsiteDoc } from "@/types/website";

export const dynamic = "force-dynamic";

/**
 * QStash callback polling gitpage for one website build. Each tick verifies
 * the signature, bails if the doc is no longer in flight (Rebuild, or an
 * earlier tick settled it), asks gitpage for status, records the result and
 * reschedules if still pending and under the cap.
 *
 * The cap comes from gitpage's `estimatedDurationSeconds`: pollAttemptCapFor
 * gives 45 ticks (15 min) for a standard build and up to 120 for premium;
 * pollDelayFor backs off from 20s to 40s after five minutes. Terminal states
 * go through settleWebsiteBuild, shared with the build.settled callback, so
 * the premium hand-off runs exactly once.
 */

interface PollPayload {
  subAccountId?: string;
  siteId?: string;
  formResponseId?: string;
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string; siteId: string }> },
) {
  const { id: subAccountId, siteId } = await ctx.params;

  if (!qstashIsConfigured()) {
    return NextResponse.json(
      { error: "QStash is not configured." },
      { status: 503 },
    );
  }

  const signature = request.headers.get("upstash-signature");
  if (!signature) {
    return NextResponse.json(
      { error: "Missing Upstash-Signature header" },
      { status: 401 },
    );
  }

  const rawBody = await request.text();
  const valid = await verifyQStashSignature(signature, rawBody);
  if (!valid) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: PollPayload;
  try {
    payload = JSON.parse(rawBody) as PollPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (
    payload.subAccountId !== subAccountId ||
    payload.siteId !== siteId ||
    typeof payload.formResponseId !== "string"
  ) {
    return NextResponse.json(
      { error: "Body must include subAccountId + siteId + formResponseId" },
      { status: 400 },
    );
  }

  const db = getAdminDb();
  const docRef = db.doc(`subAccounts/${subAccountId}/website/${siteId}`);
  const snap = await docRef.get();
  if (!snap.exists) {
    // Deleted since scheduling.
    return NextResponse.json({ ok: true, ignored: "doc-missing" });
  }
  const websiteDoc = snap.data() as WebsiteDoc;

  // No longer chasing this job (rebuilt, or already settled).
  if (
    websiteDoc.gitpageJobId !== payload.formResponseId ||
    (websiteDoc.status !== "queued" && websiteDoc.status !== "building")
  ) {
    return NextResponse.json({ ok: true, ignored: "stale-tick" });
  }

  const attempts = (websiteDoc.pollAttempts ?? 0) + 1;

  // Fail once the job has had 1.5x gitpage's estimate.
  const maxAttempts = pollAttemptCapFor(websiteDoc.estimatedDurationSeconds);
  if (attempts > maxAttempts) {
    const minutes = Math.round(
      ((websiteDoc.estimatedDurationSeconds ?? 300) * 1.5) / 60,
    );
    await docRef.update({
      status: "failed",
      errorMessage: `Build is taking longer than expected (${minutes}+ min). gitpage may still finish — click Re-check now in a few minutes.`,
      pollAttempts: attempts,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return NextResponse.json({ ok: true, settled: "timeout" });
  }

  let pollResult;
  try {
    pollResult = await pollBuild(payload.formResponseId);
  } catch (err) {
    // gitpage: 4xx is terminal for the build (401 bad key, 404 job lost, 429
    // hourly cap), so settle. 5xx and network errors are worth retrying: record
    // the attempt and reschedule ourselves rather than burn a QStash retry.
    if (
      err instanceof GitpageError &&
      err.status >= 400 &&
      err.status < 500
    ) {
      // Bad API key: flip the cached gitpage status so the activation panel shows
      // the right CTA.
      if (err.status === 401) {
        await markGitpageKeyInvalid();
      }
      await docRef.update({
        status: "failed",
        errorMessage: `gitpage rejected the poll: ${err.message}`,
        pollAttempts: attempts,
        updatedAt: FieldValue.serverTimestamp(),
      });
      return NextResponse.json({ ok: true, settled: "client-error" });
    }
    console.warn("[website/poll] gitpage poll threw — rescheduling", err);
    await docRef.update({
      pollAttempts: attempts,
      updatedAt: FieldValue.serverTimestamp(),
    });
    await rescheduleNext(
      subAccountId,
      siteId,
      payload.formResponseId,
      attempts,
    );
    return NextResponse.json({ ok: true, deferred: "transient" });
  }

  if (pollResult.isTerminal) {
    const settled = await settleWebsiteBuild({
      subAccountId,
      siteId,
      site: websiteDoc,
      result: pollResult,
      attempts,
    });
    return NextResponse.json({ ok: true, settled });
  }

  // Still in flight: move to "building" once past queued, record the attempt,
  // reschedule.
  //
  // Don't add a "stuck" heuristic based on gitpage's updatedAt. It doesn't
  // move during a healthy 10-14 min generation, so such a check fails builds
  // that are about to publish. The attempt cap is the safety net.
  const nextStatus =
    pollResult.statusPhase && pollResult.statusPhase !== "processing"
      ? "building"
      : websiteDoc.status;

  await docRef.update({
    status: nextStatus,
    statusPhase: pollResult.statusPhase,
    pollAttempts: attempts,
    updatedAt: FieldValue.serverTimestamp(),
  });
  const rescheduled = await rescheduleNext(
    subAccountId,
    siteId,
    payload.formResponseId,
    attempts,
  );
  if (!rescheduled) {
    // Publish failed, so the chain is dead. Mark failed instead of leaving it
    // stuck in queued/building, so the operator can Rebuild or Re-check.
    await docRef.update({
      status: "failed",
      errorMessage:
        "Couldn't schedule the next poll. Try Re-check now or Rebuild.",
      pollAttempts: attempts,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return NextResponse.json({ ok: true, settled: "reschedule-failed" });
  }
  return NextResponse.json({ ok: true, deferred: "in-progress" });
}

/**
 * Schedules the next tick with a fresh deduplicationId (attempt-suffixed).
 * Returns false on failure; callers must mark the doc failed.
 */
async function rescheduleNext(
  subAccountId: string,
  siteId: string,
  formResponseId: string,
  attempts: number,
): Promise<boolean> {
  const result = await publishCallback({
    pathname: `/api/sub-accounts/${subAccountId}/website/${siteId}/poll`,
    body: { subAccountId, siteId, formResponseId },
    delaySeconds: pollDelayFor(attempts),
    deduplicationId: `website_${subAccountId}_${siteId}_${formResponseId}_${attempts}`,
  });
  return result !== null;
}
