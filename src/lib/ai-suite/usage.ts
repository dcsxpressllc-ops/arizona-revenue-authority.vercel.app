import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import type { AiSuiteLevel } from "@/types/ai-suite";

/**
 * Per-day AI Suite usage counters. One doc per UTC day under the tenant:
 * `subAccounts/{id}/aiSuiteUsage/{day}` or `agencies/{agencyId}/aiSuiteUsage/{day}`.
 * Admin SDK only, so no rules or indexes. Best-effort: a failed write never
 * blocks the action.
 */

export interface AiSuiteUsageDay {
  date: string; // YYYY-MM-DD (UTC)
  messages: number;
  actions: number;
}

function dayId(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function collectionPath(
  level: AiSuiteLevel,
  agencyId: string,
  subAccountId?: string,
): string | null {
  if (level === "sub-account") {
    return subAccountId ? `subAccounts/${subAccountId}/aiSuiteUsage` : null;
  }
  return agencyId ? `agencies/${agencyId}/aiSuiteUsage` : null;
}

/** Fire-and-forget. */
export async function recordAiSuiteUsage(input: {
  level: AiSuiteLevel;
  agencyId: string;
  subAccountId?: string;
  kind: "message" | "action";
}): Promise<void> {
  const path = collectionPath(input.level, input.agencyId, input.subAccountId);
  if (!path) return;
  try {
    const day = dayId(new Date());
    await getAdminDb()
      .doc(`${path}/${day}`)
      .set(
        {
          date: day,
          messages: FieldValue.increment(input.kind === "message" ? 1 : 0),
          actions: FieldValue.increment(input.kind === "action" ? 1 : 0),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
  } catch (err) {
    console.warn("[ai-suite/usage] failed to record usage:", err);
  }
}

/** Oldest first, gaps filled with zeros so the tracker renders a full strip. */
export async function readAiSuiteUsage(input: {
  level: AiSuiteLevel;
  agencyId: string;
  subAccountId?: string;
  days?: number;
}): Promise<AiSuiteUsageDay[]> {
  const days = input.days ?? 14;
  const path = collectionPath(input.level, input.agencyId, input.subAccountId);

  const ids: string[] = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    ids.push(dayId(d));
  }
  if (!path) return ids.map((date) => ({ date, messages: 0, actions: 0 }));

  const db = getAdminDb();
  const refs = ids.map((id) => db.doc(`${path}/${id}`));
  const snaps = await db.getAll(...refs);
  return snaps.map((snap, idx) => {
    const data = snap.data();
    return {
      date: ids[idx],
      messages: typeof data?.messages === "number" ? data.messages : 0,
      actions: typeof data?.actions === "number" ? data.actions : 0,
    };
  });
}
