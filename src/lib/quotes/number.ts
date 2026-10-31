import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import type { QuoteKind } from "@/types/quotes";

/**
 * Quote / invoice numbers: `Q-YYYY-NNNN` and `INV-YYYY-NNNN`, with a separate
 * counter per sub-account and kind at
 * subAccounts/{id}/counters/{quoteNumbers|invoiceNumbers} = { year, seq, updatedAt }.
 * Issued in a transaction so concurrent operators get distinct values; a new
 * year resets seq to 0.
 */

const PADDING = 4;

interface KindMeta {
  counterDoc: string;
  prefix: string;
}

const KIND_META: Record<QuoteKind, KindMeta> = {
  quote: { counterDoc: "quoteNumbers", prefix: "Q" },
  invoice: { counterDoc: "invoiceNumbers", prefix: "INV" },
};

export async function issueQuoteNumber(
  subAccountId: string,
  kindOrDate?: QuoteKind | Date,
  maybeDate?: Date,
): Promise<string> {
  // Older callers pass (id) or (id, now); newer ones pass kind explicitly.
  let kind: QuoteKind = "quote";
  let now: Date = new Date();
  if (kindOrDate instanceof Date) {
    now = kindOrDate;
  } else if (typeof kindOrDate === "string") {
    kind = kindOrDate;
    if (maybeDate) now = maybeDate;
  }

  if (!subAccountId) throw new Error("subAccountId required");
  const meta = KIND_META[kind];
  const year = now.getUTCFullYear();

  const db = getAdminDb();
  const counterRef = db
    .collection("subAccounts")
    .doc(subAccountId)
    .collection("counters")
    .doc(meta.counterDoc);

  const seq = await db.runTransaction(async (tx) => {
    const snap = await tx.get(counterRef);
    const data = snap.exists ? snap.data() : null;
    const sameYear = data && data.year === year;
    const nextSeq = (sameYear ? (data?.seq ?? 0) : 0) + 1;
    tx.set(
      counterRef,
      {
        year,
        seq: nextSeq,
        updatedAt: new Date(),
      },
      { merge: true },
    );
    return nextSeq;
  });

  return `${meta.prefix}-${year}-${String(seq).padStart(PADDING, "0")}`;
}
