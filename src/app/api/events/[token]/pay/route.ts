import "server-only";

import { NextResponse } from "next/server";
import Stripe from "stripe";

import { getAdminDb } from "@/lib/firebase/admin";
import { verifyEventToken } from "@/lib/booking/event-token";
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
import { eventStatus } from "@/types/events";
import type { CalendarEvent } from "@/types/events";
import type { OrderLineItem } from "@/types/orders";

export const dynamic = "force-dynamic";

/**
 * Public card deposit for a booking in `awaiting_payment`. The HMAC token is
 * the credential and must match the stored `publicTokenHash`, so rotated
 * tokens kill old links. The amount comes from the event's snapshotted
 * `paymentAmount`, never the client.
 *
 * On success the reconciler calls `markBookingPaidServerSide()`, the same path
 * as the operator's "Mark as paid". Pages without Stripe keep the paypal.me link.
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

  const verified = verifyEventToken(token);
  if (!verified) return fail("This payment link isn't valid.", 404);

  const db = getAdminDb();
  const snap = await db.doc(`events/${verified.eventId}`).get();
  if (!snap.exists) return fail("This payment link isn't valid.", 404);

  const event = { id: snap.id, ...(snap.data() as Omit<CalendarEvent, "id">) };
  if (event.publicTokenHash !== verified.hash) {
    return fail(
      "This link is out of date. Please use the most recent email.",
      404,
    );
  }

  const status = eventStatus(event);
  if (status !== "awaiting_payment") {
    // Already paid, cancelled or expired.
    return fail(
      status === "scheduled"
        ? "This booking is already confirmed."
        : "This booking is no longer awaiting payment.",
      409,
    );
  }

  const amount = event.paymentAmount ?? 0;
  if (!amount || amount <= 0) {
    return fail("This booking has no deposit to pay.", 409);
  }

  const subSnap = await db.doc(`subAccounts/${event.subAccountId}`).get();
  if (subSnap.data()?.paymentsEnabledByAgency !== true) {
    return fail("Card payment isn't available for this booking.", 409);
  }

  // Fail early with a specific message if Stripe or its webhook isn't set up.
  try {
    await getSubAccountStripe(event.subAccountId);
  } catch (err) {
    if (err instanceof StripeConnectionError) {
      console.error(
        `[events/pay] connection unusable sa=${event.subAccountId} code=${err.code}`,
      );
      return fail(
        "Card payment is temporarily unavailable. Please use the other payment option or contact the organiser.",
        503,
      );
    }
    throw err;
  }

  // Booking amounts are in major units (dollars); orders and Stripe use cents.
  const amountCents = Math.round(amount * 100);
  const currency = (event.paymentCurrency || "USD").toLowerCase();
  const label = event.title || "Booking deposit";
  const lineItems: OrderLineItem[] = [
    {
      productId: null,
      name: label,
      description: "Deposit",
      unitPriceCents: amountCents,
      quantity: 1,
      isBump: false,
    },
  ];

  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
  let session: Stripe.Checkout.Session;
  try {
    session = await createCheckoutSessionForSubAccount({
      subAccountId: event.subAccountId,
      params: {
        mode: "payment",
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency,
              unit_amount: amountCents,
              product_data: { name: label, description: "Deposit" },
            },
          },
        ],
        success_url: `${base}/e/${token}?paid=1`,
        cancel_url: `${base}/e/${token}?cancelled=1`,
        metadata: {
          leadstackSubAccountId: event.subAccountId,
          leadstackEventId: event.id,
        },
      },
    });
  } catch (err) {
    const mapped = mapStripeSessionError(err);
    console.error(
      `[events/pay] stripe session failed event=${event.id} — ${mapped.logDetail}`,
    );
    return fail(mapped.buyerMessage, mapped.status);
  }

  if (!session.url) return fail("Card payment is temporarily unavailable.", 502);

  try {
    await createPendingOrder({
      agencyId: event.agencyId,
      subAccountId: event.subAccountId,
      contactId: event.contactId ?? null,
      checkoutPageId: null,
      eventId: event.id,
      source: "booking_deposit",
      currency,
      lineItems,
      stripeCheckoutSessionId: session.id,
      livemode: session.livemode,
      buyerEmail: null,
      buyerName: null,
      attribution: null,
    });
  } catch (err) {
    // No order row means the webhook can't confirm the booking, so the slot
    // would stay held and silently expire after a payment. Refuse instead.
    console.error(`[events/pay] pending order write failed event=${event.id}`, err);
    return fail("Card payment is temporarily unavailable.", 500);
  }

  return NextResponse.json({ url: session.url });
}
