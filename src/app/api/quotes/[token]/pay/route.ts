import "server-only";

import { NextResponse } from "next/server";
import Stripe from "stripe";

import { getAdminDb } from "@/lib/firebase/admin";
import { verifyQuoteToken } from "@/lib/quotes/token";
import { computeQuoteTotals, effectiveQuoteStatus } from "@/lib/quotes/calc";
import { mapStripeSessionError } from "@/lib/stripe/session-error";
import {
  createCheckoutSessionForSubAccount,
  getSubAccountStripe,
  StripeConnectionError,
} from "@/lib/stripe/sub-account-client";
import { createPendingOrder } from "@/lib/server/orders-service";
import {
  checkCheckoutRateLimit,
  clientIpFrom,
} from "@/lib/checkout/rate-limit";
import type { Quote } from "@/types/quotes";
import type { OrderLineItem } from "@/types/orders";

export const dynamic = "force-dynamic";

/**
 * Public "Pay by card" for an invoice. The HMAC token is the credential (same
 * as /api/quotes/[token]/respond): verify it, then compare its hash to
 * `publicTokenHash` so a re-sent invoice kills older links.
 *
 * No request body. The amount is recomputed from the invoice's line items
 * with computeQuoteTotals(), the same function the page and PDF use, so the
 * charge matches what was shown. On payment the webhook marks the order and
 * invoice paid via markQuotePaidServerSide(), the same path as manual
 * "Mark as paid". Invoices without Stripe keep their paypal.me link.
 */

function fail(message: string, status = 400): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ token: string }> },
) {
  const { token } = await ctx.params;

  const rate = checkCheckoutRateLimit(clientIpFrom(request));
  if (!rate.ok) {
    return NextResponse.json(
      { error: "Too many attempts. Please try again shortly." },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSec) } },
    );
  }

  const verified = verifyQuoteToken(token);
  // 404 so a bad token never confirms the invoice exists.
  if (!verified) return fail("This payment link isn't valid.", 404);

  const db = getAdminDb();
  const quoteRef = db.doc(`quotes/${verified.quoteId}`);
  const snap = await quoteRef.get();
  if (!snap.exists) return fail("This payment link isn't valid.", 404);

  const quote = { id: snap.id, ...(snap.data() as Omit<Quote, "id">) };
  if (quote.publicTokenHash !== verified.hash) {
    return fail(
      "A newer version of this invoice has been sent. Please use the most recent email.",
      404,
    );
  }
  if (quote.kind !== "invoice") {
    return fail("Only invoices can be paid online.", 409);
  }
  if (quote.status === "paid") {
    return fail("This invoice has already been paid.", 409);
  }
  if (effectiveQuoteStatus(quote) === "expired") {
    return fail("This invoice has expired. Please ask for a new one.", 409);
  }
  if (quote.status !== "sent" && quote.status !== "viewed") {
    return fail("This invoice isn't ready for payment.", 409);
  }

  // Payments may have been switched off since the invoice went out.
  const subSnap = await db.doc(`subAccounts/${quote.subAccountId}`).get();
  if (subSnap.data()?.paymentsEnabledByAgency !== true) {
    return fail("Card payment isn't available for this invoice.", 409);
  }

  const totals = computeQuoteTotals(quote);
  if (totals.total <= 0) {
    return fail("This invoice has nothing to pay.", 409);
  }

  const currency = (quote.currency || "USD").toLowerCase();
  // Quote line items are whole units (legacy schema); orders are cents.
  const totalCents = Math.round(totals.total * 100);
  const lineItems: OrderLineItem[] = [
    {
      productId: null,
      name: `Invoice ${quote.quoteNumber}`,
      description: "",
      unitPriceCents: totalCents,
      quantity: 1,
      isBump: false,
    },
  ];

  // Fail fast with a specific message when the workspace isn't connected or
  // its webhook isn't set up, instead of a generic session-create error.
  try {
    await getSubAccountStripe(quote.subAccountId);
  } catch (err) {
    if (err instanceof StripeConnectionError) {
      console.error(
        `[quotes/pay] connection unusable sa=${quote.subAccountId} code=${err.code}`,
      );
      return fail(
        "Card payment is temporarily unavailable. Please use the other payment option or contact the sender.",
        503,
      );
    }
    throw err;
  }

  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
  let session: Stripe.Checkout.Session;
  try {
    session = await createCheckoutSessionForSubAccount({
      subAccountId: quote.subAccountId,
      params: {
        mode: "payment",
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency,
              unit_amount: totalCents,
              product_data: { name: `Invoice ${quote.quoteNumber}` },
            },
          },
        ],
        success_url: `${base}/q/${token}?paid=1`,
        cancel_url: `${base}/q/${token}?cancelled=1`,
        metadata: {
          leadstackSubAccountId: quote.subAccountId,
          leadstackQuoteId: quote.id,
        },
      },
    });
  } catch (err) {
    const mapped = mapStripeSessionError(err);
    console.error(
      `[quotes/pay] stripe session failed quote=${quote.id} — ${mapped.logDetail}`,
    );
    return fail(mapped.buyerMessage, mapped.status);
  }

  if (!session.url) return fail("Card payment is temporarily unavailable.", 502);

  try {
    await createPendingOrder({
      agencyId: quote.agencyId,
      subAccountId: quote.subAccountId,
      contactId: quote.contactId,
      checkoutPageId: null,
      quoteId: quote.id,
      source: "quote",
      currency,
      lineItems,
      stripeCheckoutSessionId: session.id,
      livemode: session.livemode,
      buyerEmail: null,
      buyerName: null,
      attribution: null,
    });
  } catch (err) {
    // No order row means the webhook can't mark the invoice paid, so don't take
    // the payment.
    console.error(`[quotes/pay] pending order write failed quote=${quote.id}`, err);
    return fail("Card payment is temporarily unavailable.", 500);
  }

  return NextResponse.json({ url: session.url });
}
