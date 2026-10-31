import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import type { AiSuiteLevel } from "@/types/ai-suite";

/**
 * Append-only audit row per confirmed AI Suite action: who confirmed, which
 * capability, args, outcome. Admin SDK, tenancy-stamped.
 */
export async function recordAiSuiteAction(entry: {
  level: AiSuiteLevel;
  capability: string;
  args: Record<string, unknown>;
  summary: string;
  status: "executed" | "failed";
  agencyId: string;
  subAccountId: string | null;
  confirmedByUid: string;
  confirmedByEmail: string;
  resultRef?: { kind: string; id: string } | null;
  error?: string | null;
}): Promise<void> {
  try {
    await getAdminDb()
      .collection("aiSuiteActions")
      .add({
        level: entry.level,
        capability: entry.capability,
        args: entry.args,
        summary: entry.summary,
        status: entry.status,
        agencyId: entry.agencyId,
        subAccountId: entry.subAccountId,
        confirmedByUid: entry.confirmedByUid,
        confirmedByEmail: entry.confirmedByEmail,
        resultRef: entry.resultRef ?? null,
        error: entry.error ?? null,
        createdAt: FieldValue.serverTimestamp(),
      });
  } catch (err) {
    // The action already succeeded; an audit failure shouldn't reach the user.
    console.warn("[ai-suite/audit] failed to record action:", err);
  }
}
