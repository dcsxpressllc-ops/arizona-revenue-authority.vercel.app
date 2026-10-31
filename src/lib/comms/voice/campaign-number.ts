import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";

/**
 * Campaign codes `VC-YYYY-NNNN`, per sub-account, resetting yearly (like
 * lib/quotes/number.ts). Counter at subAccounts/{id}/counters/voiceCampaignNumbers
 * as { year, seq, updatedAt }. Runs in a transaction so simultaneous launches
 * get distinct codes.
 */

const PADDING = 4;

export async function issueVoiceCampaignCode(
  subAccountId: string,
  now: Date = new Date(),
): Promise<string> {
  if (!subAccountId) throw new Error("subAccountId required");
  const year = now.getUTCFullYear();

  const db = getAdminDb();
  const counterRef = db
    .collection("subAccounts")
    .doc(subAccountId)
    .collection("counters")
    .doc("voiceCampaignNumbers");

  const seq = await db.runTransaction(async (tx) => {
    const snap = await tx.get(counterRef);
    const data = snap.exists ? snap.data() : null;
    const sameYear = data && data.year === year;
    const nextSeq = (sameYear ? (data?.seq ?? 0) : 0) + 1;
    tx.set(counterRef, { year, seq: nextSeq, updatedAt: new Date() }, { merge: true });
    return nextSeq;
  });

  return `VC-${year}-${String(seq).padStart(PADDING, "0")}`;
}
