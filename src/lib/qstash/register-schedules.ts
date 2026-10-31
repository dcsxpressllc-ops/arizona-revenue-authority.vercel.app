import "server-only";

import { Client } from "@upstash/qstash";
import { FieldValue, type Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";

/**
 * Registers the daily QStash cron schedules on cold start, so setting the
 * QStash env vars is enough; no dashboard step.
 *
 * Stable `scheduleId`s make it idempotent (create with an existing id
 * replaces). A 24h marker at `system/scheduleRegistration` cuts the steady
 * state to one Firestore read instead of two QStash calls; it stores the
 * baseUrl too, so a changed NEXT_PUBLIC_APP_URL re-registers immediately.
 *
 * QStash or marker failures are logged and skipped; existing schedules keep
 * running and the next cold start retries.
 *
 * New schedule: append to SCHEDULES with a stable id (random ids create duplicates).
 */

interface ScheduleSpec {
  scheduleId: string;
  path: string;
  cron: string;
  description: string;
}

const SCHEDULES: ScheduleSpec[] = [
  {
    scheduleId: "leadstack-gitpage-heartbeat",
    path: "/api/cron/gitpage-heartbeat",
    cron: "0 3 * * *",
    description: "Daily gitpage telemetry + subscription status cache.",
  },
  {
    scheduleId: "leadstack-api-cleanup",
    path: "/api/cron/api-cleanup",
    cron: "0 4 * * *",
    description:
      "Daily sweep of expired apiRequestLogs / apiIdempotency / webhookEvents.",
  },
  {
    scheduleId: "leadstack-agents-watchdog",
    path: "/api/agents/watchdog/step",
    cron: "0 * * * *",
    description:
      "Hourly Inbox Follow-up Watchdog sweep (Labs custom agent).",
  },
  {
    scheduleId: "leadstack-usage-close",
    path: "/api/cron/usage-close",
    cron: "0 3 * * *",
    description:
      "Daily usage billing: close last month, mint usage charges, send reminders (no-op unless rebilling is on).",
  },
  {
    scheduleId: "leadstack-gcal-import",
    path: "/api/google/calendar-import/step",
    cron: "*/15 * * * *",
    description:
      "Google Calendar import for members who opted in (no-op unless a workspace allows it).",
  },
];

const MARKER_PATH = "system/scheduleRegistration";
const SKIP_AGE_MS = 24 * 60 * 60 * 1000;

function tsToDate(ts: Timestamp | Date | null | undefined): Date | null {
  if (!ts) return null;
  if (ts instanceof Date) return ts;
  if (typeof (ts as Timestamp).toDate === "function") {
    return (ts as Timestamp).toDate();
  }
  return null;
}

export async function ensureSchedulesRegistered(): Promise<void> {
  // No QStash credentials (e.g. local dev without a tunnel): nothing to do.
  if (!process.env.QSTASH_TOKEN) return;
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (!baseUrl) return;
  // Avoid churning QStash on dev hot reloads. `pnpm build && pnpm start`
  // still registers, so the full flow can be tested locally.
  if (process.env.NODE_ENV !== "production") return;

  const db = getAdminDb();
  const markerRef = db.doc(MARKER_PATH);

  try {
    const snap = await markerRef.get();
    if (snap.exists) {
      const data = snap.data() ?? {};
      const lastUrl = data.baseUrl as string | undefined;
      const lastAt = tsToDate(data.registeredAt);
      // A schedule added since the last run registers now, not in up to 24h.
      const lastIds = (data.scheduleIds as string[] | undefined) ?? [];
      const allKnown = SCHEDULES.every((s) => lastIds.includes(s.scheduleId));
      if (
        lastUrl === baseUrl &&
        allKnown &&
        lastAt &&
        Date.now() - lastAt.getTime() < SKIP_AGE_MS
      ) {
        return;
      }
    }
  } catch (err) {
    // Not fatal; re-register.
    console.warn("[schedules] marker read failed; will re-register", err);
  }

  const client = new Client({
    token: process.env.QSTASH_TOKEN,
    ...(process.env.QSTASH_URL ? { baseUrl: process.env.QSTASH_URL } : {}),
  });

  const results: Array<{ id: string; ok: boolean; error?: string }> = [];
  for (const s of SCHEDULES) {
    try {
      await client.schedules.create({
        scheduleId: s.scheduleId,
        destination: `${baseUrl}${s.path}`,
        cron: s.cron,
      });
      results.push({ id: s.scheduleId, ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown";
      console.warn(
        `[schedules] failed to register ${s.scheduleId}: ${message}`,
      );
      results.push({ id: s.scheduleId, ok: false, error: message });
    }
  }

  // Write the marker even on partial failure so cold starts don't hammer
  // QStash. A failed schedule won't succeed a minute later anyway.
  try {
    await markerRef.set(
      {
        baseUrl,
        registeredAt: FieldValue.serverTimestamp(),
        scheduleIds: SCHEDULES.map((s) => s.scheduleId),
        lastResults: results,
      },
      { merge: true },
    );
  } catch (err) {
    console.warn("[schedules] marker write failed", err);
  }
}
