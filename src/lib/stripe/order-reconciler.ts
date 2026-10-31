import "server-only";

import type Stripe from "stripe";

import { formatCurrency } from "@/lib/format";
import { getAdminDb } from "@/lib/firebase/admin";
import { reconcileContactFromCapture } from "@/lib/comms/ai/capture";
import {
  emitOrderEvents,
  findOrderByCheckoutSession,
  findOrderByPaymentIntent,
  markOrderPaid,
  recordOrderRefund,
} from "@/lib/server/orders-service";
import { markQuotePaidServerSide } from "@/lib/server/quotes-service";
import { markBookingPaidServerSide } from "@/lib/server/bookings-service";
import { markPurchasePaidServerSide } from "@/lib/server/community-purchase-service";
import {
  grantForOrder,
  orderDelivers,
  revokeForOrder,
} from "@/lib/server/entitlements-service";
import { sendOrderConfirmation } from "@/lib/server/order-confirmation-service";
import type { Order } from "@/types/orders";

/**
 * Shared Stripe-to-order reconciler. Tier-agnostic: it never knows which route
 * fed it.
 *
 *   /api/webhooks/stripe/sa/[subAccountId]  Tier 1, per-account endpoint + secret
 *   /api/webhooks/stripe/connect            Tier 2, platform endpoint, sub-account from event.account
 *
 * Routes only verify signatures and resolve the sub-account. Keep all order
 * logic here. Not to be confused with lib/stripe/webhooks.ts, which handles the
 * agency's own Stripe account.
 *
 * Never throws; the caller always 200s. A throw makes Stripe retry a payment we
 * may have recorded, and repeated failures disable the client's endpoint.
 */

/** `purchase.grantedByUid` when access came from a Stripe payment rather than a staff "mark paid". */
const STRIPE_GRANTOR = "system:stripe";

export interface ReconcileResult {
  handled: boolean;
  /** For logs only. */
  detail: string;
}

export async function reconcileStripeEvent(input: {
  subAccountId: string;
  event: Stripe.Event;
}): Promise<ReconcileResult> {
  const { subAccountId, event } = input;

  try {
    switch (event.type) {
      case "checkout.session.completed":
        return await handleCheckoutCompleted(subAccountId, event);
      case "charge.refunded":
        return await handleChargeRefunded(subAccountId, event);
      case "charge.dispute.created":
        return await handleDisputeCreated(subAccountId, event);
      default:
        return { handled: false, detail: `ignored ${event.type}` };
    }
  } catch (err) {
    console.error(
      `[order-reconciler] ${event.type} failed sa=${subAccountId} event=${event.id}`,
      err,
    );
    return { handled: false, detail: "error" };
  }
}

async function handleCheckoutCompleted(
  subAccountId: string,
  event: Stripe.Event,
): Promise<ReconcileResult> {
  const session = event.data.object as Stripe.Checkout.Session;

  // Unpaid sessions do exist (async payment methods). Only money counts.
  if (session.payment_status !== "paid") {
    return { handled: false, detail: `payment_status=${session.payment_status}` };
  }

  const order = await findOrderByCheckoutSession(session.id);
  if (!order) {
    // A session we never created. Log loudly: in Tier 1 the operator controls
    // the endpoint and could point another integration's events at us.
    console.warn(
      `[order-reconciler] no order for session=${session.id} sa=${subAccountId}`,
    );
    return { handled: false, detail: "no matching order" };
  }

  // Cross-tenant guard: the route proved this sub-account's secret, but don't
  // trust the lookup if the session id collides with another tenant's order.
  if (order.subAccountId !== subAccountId) {
    console.error(
      `[order-reconciler] tenancy mismatch order=${order.id} expected=${subAccountId} got=${order.subAccountId}`,
    );
    return { handled: false, detail: "tenancy mismatch" };
  }

  const paymentIntentId =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : (session.payment_intent?.id ?? null);

  const marked = await markOrderPaid({
    orderId: order.id,
    stripePaymentIntentId: paymentIntentId,
    buyerEmail: session.customer_details?.email ?? null,
    buyerName: session.customer_details?.name ?? null,
  });

  // Idempotency point: a redelivered event finds the order paid and stops here.
  if (!marked.changed || !marked.order) {
    return { handled: true, detail: "already paid (idempotent no-op)" };
  }
  let updated = marked.order;

  // Express buy-link orders are created before we know the buyer. The contact
  // must exist before emitOrderEvents, which skips workflows and the activity
  // row when there is none. Past the idempotency point, so a replay can't run it twice.
  if (updated.source === "product_link" && !updated.contactId && updated.buyerEmail) {
    try {
      const res = await reconcileContactFromCapture({
        agencyId: updated.agencyId,
        subAccountId: updated.subAccountId,
        existingContactId: null,
        pageUrl: null,
        source: "checkout",
        matchStrategy: "email-first",
        capture: {
          // Wallet/Link payments can leave the billing name empty; the name
          // we ask for lands in individual_name.
          name:
            updated.buyerName ?? session.customer_details?.individual_name ?? null,
          // Contacts match on exact email, so normalise like the checkout route.
          email: updated.buyerEmail.trim().toLowerCase(),
          phone: session.customer_details?.phone ?? null,
        },
      });
      if (res?.contactId) {
        await getAdminDb()
          .doc(`orders/${updated.id}`)
          .update({ contactId: res.contactId });
        updated = { ...updated, contactId: res.contactId };
      }
    } catch (err) {
      // Never undo a recorded payment over this; the order keeps the buyer's email.
      console.error(
        `[order-reconciler] express contact failed order=${updated.id}`,
        err,
      );
    }
  }

  emitOrderEvents({
    order: updated,
    type: "order.paid",
    activity: {
      type: "order_paid",
      content: `Paid ${formatCurrency(
        updated.totalCents / 100,
        updated.currency.toUpperCase(),
      )} by card.`,
    },
  });

  // Order is paid and its events fired; failures below must not undo that.
  // Confirmation first so it lands before any delivery email. When it went
  // out, it already carries the download links.
  let confirmed = false;
  if (orderDelivers(updated)) {
    confirmed = (await sendOrderConfirmation(updated)).ok;
  }
  await applySourceEffects(updated, { downloadsEmailed: confirmed });

  return { handled: true, detail: `order ${updated.id} paid` };
}

/**
 * Bring the originating surface in line with a paid order, one branch per
 * `order.source`. Kept separate from markOrderPaid so the money record stands
 * even if the source was deleted. Never throws; worst case an invoice still
 * reads "sent" and needs a manual Mark as paid.
 */
async function applySourceEffects(
  order: Order,
  opts: { downloadsEmailed?: boolean } = {},
): Promise<void> {
  try {
    if (order.source === "quote" && order.quoteId) {
      // Same service as the "Mark as paid" button, so activity, `quote.paid`
      // trigger, webhook and review request fire once. Its own guard makes replays no-ops.
      const res = await markQuotePaidServerSide({
        quoteId: order.quoteId,
        expectSubAccountId: order.subAccountId,
      });
      if (!res.ok && res.code !== "already_paid") {
        console.warn(
          `[order-reconciler] invoice ${order.quoteId} not marked paid: ${res.code} — ${res.message}`,
        );
      }
    }

    if (order.source === "booking_deposit" && order.eventId) {
      // Same service as the manual "Mark as paid": rotates the token, clears the
      // hold, schedules reminders, sends the ICS. The awaiting_payment guard stops
      // a replay from sending a second confirmation.
      const res = await markBookingPaidServerSide({
        eventId: order.eventId,
        expectSubAccountId: order.subAccountId,
        paidByUid: null,
      });
      if (!res.ok && res.code !== "bad_status") {
        console.warn(
          `[order-reconciler] booking ${order.eventId} not confirmed: ${res.code} — ${res.message}`,
        );
      }
    }
    if (
      order.source === "community" &&
      order.communityGroupId &&
      order.purchaseId
    ) {
      // Same service as the staff "mark paid": grants membership or unlocks the
      // course and fires the community events. Returns early if already paid.
      await markPurchasePaidServerSide({
        subAccountId: order.subAccountId,
        groupId: order.communityGroupId,
        purchaseId: order.purchaseId,
        grantedByUid: STRIPE_GRANTOR,
      });
    }
  } catch (err) {
    console.error(
      `[order-reconciler] source effects failed order=${order.id} source=${order.source}`,
      err,
    );
  }

  // Product deliveries run last, after every existing effect, and can't undo them.
  if (orderDelivers(order) && order.deliveries?.length) {
    await grantForOrder(order, { downloadsEmailed: opts.downloadsEmailed }).catch((err) =>
      console.error(`[order-reconciler] delivery failed order=${order.id}`, err),
    );
  }
}

async function handleChargeRefunded(
  subAccountId: string,
  event: Stripe.Event,
): Promise<ReconcileResult> {
  const charge = event.data.object as Stripe.Charge;
  const paymentIntentId =
    typeof charge.payment_intent === "string"
      ? charge.payment_intent
      : (charge.payment_intent?.id ?? null);
  if (!paymentIntentId) {
    return { handled: false, detail: "charge has no payment_intent" };
  }

  const order = await findOrderByPaymentIntent(paymentIntentId);
  if (!order) return { handled: false, detail: "no matching order" };
  if (order.subAccountId !== subAccountId) {
    console.error(
      `[order-reconciler] tenancy mismatch on refund order=${order.id} expected=${subAccountId}`,
    );
    return { handled: false, detail: "tenancy mismatch" };
  }

  // `amount_refunded` is the running total, which is what the service wants:
  // it compares against the stored total, so partial refunds accumulate.
  const { changed, order: updated } = await recordOrderRefund({
    orderId: order.id,
    refundedCentsTotal: charge.amount_refunded,
  });
  if (!changed || !updated) {
    return { handled: true, detail: "refund already recorded (idempotent no-op)" };
  }

  emitOrderEvents({
    order: updated,
    type: "order.refunded",
    activity: {
      type: "order_refunded",
      content: `Refunded ${formatCurrency(
        updated.refundedCents / 100,
        updated.currency.toUpperCase(),
      )}${updated.status === "partially_refunded" ? " (partial)" : ""}.`,
    },
  });

  // Only a full refund revokes; access stays until staff remove it.
  if (updated.status === "refunded" && orderDelivers(updated)) {
    await revokeForOrder(updated).catch((err) =>
      console.error(`[order-reconciler] revoke failed order=${updated.id}`, err),
    );
  }

  return { handled: true, detail: `order ${updated.id} ${updated.status}` };
}

/**
 * Disputes are recorded, not acted on. With direct charges the client is
 * merchant of record and fights it in their own dashboard. (Unrelated to
 * lib/stripe/dispute.ts, which covers LeadStack license sales.)
 */
async function handleDisputeCreated(
  subAccountId: string,
  event: Stripe.Event,
): Promise<ReconcileResult> {
  const dispute = event.data.object as Stripe.Dispute;
  const paymentIntentId =
    typeof dispute.payment_intent === "string"
      ? dispute.payment_intent
      : (dispute.payment_intent?.id ?? null);
  if (!paymentIntentId) return { handled: false, detail: "dispute has no payment_intent" };

  const order = await findOrderByPaymentIntent(paymentIntentId);
  if (!order || order.subAccountId !== subAccountId) {
    return { handled: false, detail: "no matching order" };
  }

  console.warn(
    `[order-reconciler] dispute opened order=${order.id} sa=${subAccountId} amount=${dispute.amount}`,
  );
  return { handled: true, detail: `dispute logged for order ${order.id}` };
}
