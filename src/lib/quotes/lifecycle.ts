import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { fireWorkflowTrigger } from "@/lib/workflows/engine";
import { emitWebhookEvent } from "@/lib/api/webhooks/dispatch";
import {
  emitDealCreatedById,
  updateDealServerSide,
} from "@/lib/server/deals-service";
import { computeQuoteTotals } from "@/lib/quotes/calc";
import { formatCurrency } from "@/lib/format";
import type { ActivityType } from "@/types/contacts";
import type { WebhookEventType } from "@/types/webhooks";
import { GLOBAL_TERRITORY_ID, type AutomationTriggerType } from "@/types";
import type { Quote } from "@/types/quotes";

/**
 * Follow-up side effects for quote lifecycle events (timeline row, workflow
 * trigger, auto-deal). Everything logs and swallows: the primary write has
 * already committed, and a missing activity row beats a 500 on the
 * recipient's accept click.
 */

type QuoteLifecycleEvent =
  | "quote_sent"
  | "quote_viewed"
  | "quote_accepted"
  | "quote_declined"
  | "quote_marked_paid";

interface RecordActivityOpts {
  /** Appended to the default content (e.g. decline reason). */
  extra?: string | null;
  contentOverride?: string;
}

/** Activity-timeline row for a quote event. createdBy = "quote" marks it as system-generated. */
export async function recordQuoteActivity(
  quote: Pick<
    Quote,
    | "id"
    | "contactId"
    | "quoteNumber"
    | "currency"
    | "lineItems"
    | "globalDiscount"
    | "globalTaxPercent"
    | "kind"
  >,
  event: QuoteLifecycleEvent,
  opts: RecordActivityOpts = {},
): Promise<void> {
  try {
    const content =
      opts.contentOverride ??
      defaultActivityContent(quote, event, opts.extra ?? null);

    await getAdminDb()
      .collection("contacts")
      .doc(quote.contactId)
      .collection("activities")
      .add({
        type: event satisfies ActivityType,
        content,
        createdBy: "quote",
        meta: { quoteId: quote.id, quoteNumber: quote.quoteNumber },
        createdAt: FieldValue.serverTimestamp(),
      });
  } catch (err) {
    console.warn(`[quotes/lifecycle] activity write failed for ${event}`, err);
  }
}

function defaultActivityContent(
  quote: Pick<
    Quote,
    | "quoteNumber"
    | "currency"
    | "lineItems"
    | "globalDiscount"
    | "globalTaxPercent"
    | "kind"
  >,
  event: QuoteLifecycleEvent,
  extra: string | null,
): string {
  const totals = computeQuoteTotals(quote);
  const totalDisplay = formatCurrency(totals.total, quote.currency);
  const label = quote.kind === "invoice" ? "Invoice" : "Quote";
  const base = `${label} ${quote.quoteNumber} (${totalDisplay})`;
  const suffix = extra ? ` — ${extra}` : "";
  switch (event) {
    case "quote_sent":
      return `${base} sent to recipient${suffix}.`;
    case "quote_viewed":
      return `${base} opened by recipient${suffix}.`;
    case "quote_accepted":
      return `${base} accepted by recipient${suffix}.`;
    case "quote_declined":
      return `${base} declined${suffix}.`;
    case "quote_marked_paid":
      return `${base} marked as paid${suffix}.`;
  }
}

/**
 * Fire the workflow trigger for a quote event. fireTriggers already swallows
 * errors, so this is safe from any post-write path.
 */
export async function fireQuoteTrigger(
  quote: Pick<Quote, "agencyId" | "subAccountId" | "contactId">,
  trigger: Extract<AutomationTriggerType, `quote_${string}`>,
): Promise<void> {
  // Invoices share the mark-paid route, so "paid" covers both kinds.
  const type =
    trigger === "quote_accepted"
      ? ("quote.accepted" as const)
      : trigger === "quote_marked_paid"
        ? ("quote.paid" as const)
        : null;
  if (type) {
    void fireWorkflowTrigger({
      agencyId: quote.agencyId,
      subAccountId: quote.subAccountId,
      type,
      contactId: quote.contactId,
    });
  }
}

/**
 * Pipeline outcome of an accepted quote; the respond route's only entry point.
 *
 * With `quote.dealId`, move that deal to Won and set its value to the quote
 * total (avoids a duplicate Won deal next to the open original).
 * updateDealServerSide fires the same activity, webhooks and workflow trigger
 * as dragging the card by hand. Without a link, fall back to the
 * `autoCreateDealOnAccept` path. If the linked deal was deleted or moved to
 * another sub-account, the move returns null and we also fall back.
 */
export async function applyDealOutcomeForAcceptedQuote(
  quote: Quote,
): Promise<void> {
  const linkedDealId =
    typeof quote.dealId === "string" && quote.dealId ? quote.dealId : null;

  if (linkedDealId) {
    try {
      const totals = computeQuoteTotals(quote);
      // Use the deal's own pipeline's Won stage, not the default pipeline's slug.
      const { wonStageIdForDeal } = await import(
        "@/lib/server/pipelines-service"
      );
      const dealSnap = await getAdminDb().doc(`deals/${linkedDealId}`).get();
      const wonId = await wonStageIdForDeal(quote.subAccountId, {
        pipelineId: dealSnap.exists
          ? ((dealSnap.data()?.pipelineId as string | null | undefined) ?? null)
          : null,
      });
      const moved = await updateDealServerSide({
        dealId: linkedDealId,
        patch: {
          stageId: wonId,
          value: totals.total,
          currency: quote.currency,
        },
        // Recipient-initiated: attribute to the quote's author.
        userId: quote.createdByUid,
        // Validated at link time, but the deal may have been re-homed since.
        // Never progress a deal outside this tenant.
        expectedSubAccountId: quote.subAccountId,
      });
      if (moved) return;
      console.warn(
        `[quotes/lifecycle] linked deal ${linkedDealId} missing at accept — falling back to auto-create`,
      );
    } catch (err) {
      console.error("[quotes/lifecycle] linked-deal move failed", err);
    }
  }

  await autoCreateDealForAcceptedQuote(quote);
}

/**
 * If `autoCreateDealOnAccept` is on, create a Won deal valued at the quote
 * total. Admin SDK version of firestore/deals.ts createDeal, since respond is
 * unauthenticated. The route's transaction prevents double-accept, so this
 * runs once per quote. Returns the deal id, or null if not created.
 */
export async function autoCreateDealForAcceptedQuote(
  quote: Quote,
): Promise<string | null> {
  if (!quote.autoCreateDealOnAccept) return null;

  try {
    const totals = computeQuoteTotals(quote);
    // Keep the deal in the contact's territory. Harmless when scoping is off.
    let territoryId: string = GLOBAL_TERRITORY_ID;
    try {
      const contactSnap = await getAdminDb()
        .collection("contacts")
        .doc(quote.contactId)
        .get();
      const raw = contactSnap.data()?.territoryId;
      territoryId = typeof raw === "string" ? raw : GLOBAL_TERRITORY_ID;
    } catch {
      territoryId = GLOBAL_TERRITORY_ID;
    }

    const ref = getAdminDb().collection("deals").doc();
    await ref.set({
      title: `Quote ${quote.quoteNumber} accepted`,
      value: totals.total,
      currency: quote.currency,
      contactId: quote.contactId,
      stageId: "won",
      priority: "medium",
      agencyId: quote.agencyId,
      subAccountId: quote.subAccountId,
      // No uid on a recipient action; attribute to the quote's creator.
      createdByUid: quote.createdByUid,
      lostReason: null,
      territoryId,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      stageChangedAt: FieldValue.serverTimestamp(),
    });

    // Same pipeline_moved activity the manual flow writes.
    try {
      await getAdminDb()
        .collection("contacts")
        .doc(quote.contactId)
        .collection("activities")
        .add({
          type: "pipeline_moved" satisfies ActivityType,
          content: `Deal "Quote ${quote.quoteNumber} accepted" created at Won (auto, from accepted quote)`,
          createdBy: "quote",
          meta: { dealId: ref.id, toStageId: "won", quoteId: quote.id },
          createdAt: FieldValue.serverTimestamp(),
        });
    } catch (err) {
      console.warn(
        "[quotes/lifecycle] auto-deal activity write failed",
        err,
      );
    }

    void emitDealCreatedById({
      subAccountId: quote.subAccountId,
      agencyId: quote.agencyId,
      dealId: ref.id,
    });

    return ref.id;
  } catch (err) {
    console.error("[quotes/lifecycle] auto-create deal failed", err);
    return null;
  }
}

const QUOTE_WEBHOOK_MAP: Record<
  QuoteLifecycleEvent,
  { type: WebhookEventType; status: string }
> = {
  quote_sent: { type: "quote.sent", status: "sent" },
  quote_viewed: { type: "quote.viewed", status: "viewed" },
  quote_accepted: { type: "quote.accepted", status: "accepted" },
  quote_declined: { type: "quote.declined", status: "declined" },
  quote_marked_paid: { type: "quote.paid", status: "paid" },
};

function tsToIsoOrNull(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  const maybe = v as { toDate?: () => Date; seconds?: number };
  if (typeof maybe.toDate === "function") return maybe.toDate().toISOString();
  if (typeof maybe.seconds === "number") {
    return new Date(maybe.seconds * 1000).toISOString();
  }
  return null;
}

/**
 * Outbound webhook for a quote event. Status comes from the event, not the
 * passed object, so a pre-update quote still yields the right payload.
 * Safe to `void`. Quotes have no test mode.
 */
export async function emitQuoteWebhook(
  quote: Quote,
  event: QuoteLifecycleEvent,
): Promise<void> {
  try {
    const { type, status } = QUOTE_WEBHOOK_MAP[event];
    const totals = computeQuoteTotals(quote);
    await emitWebhookEvent({
      subAccountId: quote.subAccountId,
      agencyId: quote.agencyId,
      mode: "live",
      type,
      payload: {
        quote: {
          id: quote.id,
          object: quote.kind === "invoice" ? "invoice" : "quote",
          kind: quote.kind ?? "quote",
          number: quote.quoteNumber,
          status,
          total: totals.total,
          currency: quote.currency,
          contact_id: quote.contactId,
          sent_at: tsToIsoOrNull(quote.sentAt),
          viewed_at: tsToIsoOrNull(quote.viewedAt),
          accepted_at: tsToIsoOrNull(quote.acceptedAt),
          declined_at: tsToIsoOrNull(quote.declinedAt),
          decline_reason: quote.declineReason ?? null,
          paid_at: tsToIsoOrNull(quote.paidAt),
          // Browser string stays out of the webhook; it is only for the certificate.
          signature: quote.signature
            ? {
                signer_name: quote.signature.signerName,
                signer_email: quote.signature.signerEmail,
                signed_at: tsToIsoOrNull(quote.signature.signedAt),
                ip_address: quote.signature.ipAddress,
                document_hash: quote.signature.documentHash,
              }
            : null,
        },
      },
    });
  } catch (err) {
    console.warn(`[quotes/lifecycle] webhook emit failed for ${event}`, err);
  }
}
