import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import {
  emitQuoteWebhook,
  fireQuoteTrigger,
  recordQuoteActivity,
} from "@/lib/quotes/lifecycle";
import { maybeSendReviewRequest } from "@/lib/reviews/request";
import type { Quote } from "@/types/quotes";
import { runAfterResponse } from "@/lib/server/after-response";

/**
 * The one path that marks a quote/invoice paid and runs its side effects. Both
 * the Stripe reconciler and the manual "Mark as paid" button use it so activity,
 * the quote.paid trigger, the webhook and the review request can't diverge.
 * Callers do auth: the route checks membership, the reconciler relies on the
 * Stripe signature.
 */

export type MarkQuotePaidOutcome =
  | { ok: true; quote: Quote & { id: string } }
  | { ok: false; code: "not_found" | "wrong_tenant" | "already_paid" | "bad_status"; message: string };

export async function markQuotePaidServerSide(input: {
  quoteId: string;
  expectSubAccountId: string;
}): Promise<MarkQuotePaidOutcome> {
  const db = getAdminDb();
  const ref = db.collection("quotes").doc(input.quoteId);
  const snap = await ref.get();
  if (!snap.exists) {
    return { ok: false, code: "not_found", message: "Quote not found" };
  }
  const quote = snap.data() as Quote;
  if (quote.subAccountId !== input.expectSubAccountId) {
    return {
      ok: false,
      code: "wrong_tenant",
      message: "Quote belongs to a different sub-account",
    };
  }
  // A replayed Stripe event or double-click must not re-fire the trigger or send
  // a second review request.
  if (quote.status === "paid") {
    return { ok: false, code: "already_paid", message: "Already marked paid" };
  }

  const allowed =
    quote.kind === "invoice"
      ? quote.status === "sent" || quote.status === "viewed"
      : quote.status === "accepted";
  if (!allowed) {
    return {
      ok: false,
      code: "bad_status",
      message:
        quote.kind === "invoice"
          ? `Only sent invoices can be marked paid. Current status: ${quote.status}`
          : `Only accepted quotes can be marked paid. Current status: ${quote.status}`,
    };
  }

  await ref.update({
    status: "paid",
    paidAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  const withId = { ...quote, id: input.quoteId, status: "paid" as const };

  // Side effects swallow their own errors; the payment already succeeded.
  await recordQuoteActivity(withId, "quote_marked_paid");
  await fireQuoteTrigger(withId, "quote_marked_paid");
  runAfterResponse(() => emitQuoteWebhook(withId, "quote_marked_paid"));
  runAfterResponse(() => maybeSendReviewRequest({
    subAccountId: quote.subAccountId,
    agencyId: quote.agencyId,
    contactId: quote.contactId,
    trigger: "quote_paid",
  }));

  return { ok: true, quote: withId };
}
