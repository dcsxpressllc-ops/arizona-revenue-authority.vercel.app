import "server-only";

import { NextResponse } from "next/server";
import Stripe from "stripe";

import { readStripeConnectionSecret } from "@/lib/stripe/sub-account-client";
import { reconcileStripeEvent } from "@/lib/stripe/order-reconciler";

export const dynamic = "force-dynamic";

/**
 * Per-sub-account Stripe webhook. Not /api/webhooks/stripe, which is the
 * agency's own Stripe and uses STRIPE_WEBHOOK_SECRET. This verifies against
 * a secret unique to one sub-account's Stripe account, stored at
 * `subAccounts/{id}/private/stripeConnection.webhookSecret`.
 *
 * Public path; the signature is the credential. The id in the URL is
 * untrusted and only picks which secret to verify with.
 *
 * 200 on everything except a bad signature. Non-2xx makes Stripe retry, and
 * repeated failures disable the endpoint on the client's own account, which
 * would break their payments where we can't fix it.
 *
 * A Connect-based sibling would resolve the sub-account from
 * `event.account` and call the same reconciler.
 */

export async function POST(
  request: Request,
  ctx: { params: Promise<{ subAccountId: string }> },
) {
  const { subAccountId } = await ctx.params;

  const body = await request.text();
  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json(
      { error: "Missing stripe-signature header" },
      { status: 400 },
    );
  }

  const conn = await readStripeConnectionSecret(subAccountId);
  if (!conn || conn.mode !== "key" || !conn.webhookSecret) {
    // Disconnected or never finished setup, but Stripe still delivers. 200 so
    // retries don't disable their endpoint; they may be reconnecting.
    console.warn(
      `[webhooks/stripe/sa] no usable connection sa=${subAccountId} — dropping event`,
    );
    return NextResponse.json({ received: true, ignored: "not_connected" });
  }

  let event: Stripe.Event;
  try {
    // Only the crypto helpers are used (no API call), so the key is incidental.
    event = new Stripe(conn.restrictedKey).webhooks.constructEvent(
      body,
      signature,
      conn.webhookSecret,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    // The one non-200 case: an unverified body isn't from Stripe.
    console.error(
      `[webhooks/stripe/sa] signature verification failed sa=${subAccountId}: ${message}`,
    );
    return NextResponse.json(
      { error: `Webhook Error: ${message}` },
      { status: 400 },
    );
  }

  const result = await reconcileStripeEvent({ subAccountId, event });
  return NextResponse.json({ received: true, ...result });
}
