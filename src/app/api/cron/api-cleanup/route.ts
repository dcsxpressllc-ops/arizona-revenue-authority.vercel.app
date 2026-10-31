import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  publishCallback,
  verifyQStashSignature,
} from "@/lib/automations/qstash";
import { sweepOldWatchdogRuns } from "@/lib/server/agents-watchdog-service";

/**
 * Daily sweep of the public API's TTL'd collections. Used instead of native
 * Firestore TTL, which needs manual console setup after cloning.
 *
 * QStash schedule (one-time): cron `0 4 * * *` ->
 * ${NEXT_PUBLIC_APP_URL}/api/cron/api-cleanup
 *
 * If a collection hits the per-run cap it re-schedules itself in 60s, keeping
 * each run well under the serverless timeout and avoiding hot tablets.
 */

const BATCH_LIMIT = 500;
const CONTINUATION_DELAY_SEC = 60;

interface SweepResult {
  collection: string;
  deleted: number;
  hitCap: boolean;
}

async function sweepFlatCollection(
  collectionGroupName: string,
  now: Date,
): Promise<SweepResult> {
  const db = getAdminDb();
  const snap = await db
    .collectionGroup(collectionGroupName)
    .where("expiresAt", "<", now)
    .limit(BATCH_LIMIT)
    .get();
  if (snap.empty) {
    return { collection: collectionGroupName, deleted: 0, hitCap: false };
  }
  // Firestore batch limit is 500 ops; BATCH_LIMIT stays under it.
  const batch = db.batch();
  for (const doc of snap.docs) batch.delete(doc.ref);
  await batch.commit();
  return {
    collection: collectionGroupName,
    deleted: snap.size,
    hitCap: snap.size >= BATCH_LIMIT,
  };
}

async function sweepWebhookEvents(now: Date): Promise<SweepResult> {
  // webhookEvents has a `deliveries` subcollection; a batch delete would orphan it.
  const db = getAdminDb();
  const snap = await db
    .collectionGroup("webhookEvents")
    .where("expiresAt", "<", now)
    .limit(BATCH_LIMIT)
    .get();
  if (snap.empty) {
    return { collection: "webhookEvents", deleted: 0, hitCap: false };
  }
  // Sequential to keep memory bounded; the Admin SDK throttles internally.
  // Past ~5k/day this should fan out via QStash.
  let deleted = 0;
  for (const doc of snap.docs) {
    await db.recursiveDelete(doc.ref);
    deleted += 1;
  }
  return {
    collection: "webhookEvents",
    deleted,
    hitCap: snap.size >= BATCH_LIMIT,
  };
}

export async function POST(request: Request) {
  const signature = request.headers.get("upstash-signature");
  const rawBody = await request.text();
  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 401 });
  }
  const valid = await verifyQStashSignature(signature, rawBody);
  if (!valid) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const startedAt = Date.now();
  const now = new Date();

  const results: SweepResult[] = [];
  try {
    results.push(await sweepFlatCollection("apiRequestLogs", now));
    results.push(await sweepFlatCollection("apiIdempotency", now));
    results.push(await sweepWebhookEvents(now));
    // Watchdog run logs older than 30 days.
    const watchdogDeleted = await sweepOldWatchdogRuns();
    results.push({
      collection: "customAgents/runs",
      deleted: watchdogDeleted,
      hitCap: false,
    });
  } catch (err) {
    console.error("[cron/api-cleanup] sweep failed", err);
    return NextResponse.json(
      {
        error: "sweep_failed",
        message: err instanceof Error ? err.message : "unknown",
        partial: results,
      },
      { status: 500 },
    );
  }

  const anyHitCap = results.some((r) => r.hitCap);

  // A sweep hit its cap: schedule a continuation to catch up after a spike.
  if (anyHitCap) {
    await publishCallback({
      pathname: "/api/cron/api-cleanup",
      body: {},
      delaySeconds: CONTINUATION_DELAY_SEC,
      // Per-minute dedup id so concurrent continuations collapse into one.
      deduplicationId: `api-cleanup_continuation_${Math.floor(Date.now() / 1000 / 60)}`,
    });
  }

  return NextResponse.json({
    ok: true,
    durationMs: Date.now() - startedAt,
    results,
    continuationScheduled: anyHitCap,
  });
}
