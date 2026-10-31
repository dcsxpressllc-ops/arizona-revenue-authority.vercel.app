import "server-only";

import { NextResponse } from "next/server";
import { verifyQStashSignature } from "@/lib/automations/qstash";
import {
  listImportTargets,
  runCalendarImport,
  sweepOrphanedImports,
} from "@/lib/google/calendar-import";

export const maxDuration = 60;

/** Leaves headroom under maxDuration; unfinished calendars go first next tick. */
const BUDGET_MS = 45_000;
/** One calendar never gets more than this, so one heavy member can't starve the rest. */
const PER_MEMBER_MS = 25_000;
const CONCURRENCY = 3;

/**
 * Google Calendar import sweep. QStash cron every 15 minutes, registered by
 * lib/qstash/register-schedules.ts; the signature is the auth (PUBLIC_PATHS).
 * Exits after one Firestore query when no workspace has import allowed. The
 * first tick after 03:00 UTC also sweeps orphaned imports.
 */
export async function POST(request: Request) {
  const signature = request.headers.get("upstash-signature");
  const rawBody = await request.text();
  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 401 });
  }
  if (!(await verifyQStashSignature(signature, rawBody))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const startedAt = Date.now();
  const budgetEnd = startedAt + BUDGET_MS;
  const nowUtc = new Date(startedAt);
  const sweepTick = nowUtc.getUTCHours() === 3 && nowUtc.getUTCMinutes() < 15;
  const swept = sweepTick
    ? await sweepOrphanedImports(startedAt + 15_000).catch((err) => {
        console.warn("[calendar-import/step] orphan sweep failed", err);
        return 0;
      })
    : 0;

  const targets = await listImportTargets();
  let done = 0;
  let failed = 0;
  let cursor = 0;
  async function worker() {
    while (cursor < targets.length && Date.now() < budgetEnd - 10_000) {
      const t = targets[cursor++];
      const deadlineMs = Math.min(budgetEnd, Date.now() + PER_MEMBER_MS);
      const r = await runCalendarImport(t.subAccountId, t.uid, {
        deadlineMs,
      }).catch(() => ({ ok: false }));
      if (r.ok) done++;
      else failed++;
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  return NextResponse.json({
    ok: true,
    targets: targets.length,
    done,
    failed,
    swept,
    durationMs: Date.now() - startedAt,
  });
}
