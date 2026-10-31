import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { emitWebhookEvent } from "@/lib/api/webhooks/dispatch";
import { fireWorkflowTrigger } from "@/lib/workflows/engine";
import { runAfterResponse } from "@/lib/server/after-response";
import {
  computeOrderSubtotalCents,
  isOrderTerminal,
  type Order,
  type OrderLineItem,
  type OrderDeliverySnapshot,
  type OrderSource,
  type OrderWebsiteRef,
} from "@/types/orders";
import type { ContactAttribution } from "@/types/contacts";
import type { WebhookEventType } from "@/types/webhooks";

/**
 * The only write path for orders/{id}. Dashboard, public checkout and the Stripe
 * reconciler all go through here so webhook, workflow and activity side effects
 * stay consistent. Doesn't care whether payment came via a restricted key or
 * Connect.
 */

export class OrderError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "OrderError";
    this.status = status;
  }
}

/** Explicit wire shape so new Firestore fields don't leak into webhook payloads. */
export interface OrderApiObject {
  id: string;
  status: Order["status"];
  currency: string;
  subtotal_cents: number;
  total_cents: number;
  refunded_cents: number;
  line_items: {
    product_id: string | null;
    name: string;
    unit_price_cents: number;
    quantity: number;
    is_bump: boolean;
  }[];
  contact_id: string | null;
  checkout_page_id: string | null;
  quote_id: string | null;
  event_id: string | null;
  purchase_id: string | null;
  source: OrderSource;
  livemode: boolean;
  buyer_email: string | null;
  buyer_name: string | null;
  stripe_checkout_session_id: string;
  stripe_payment_intent_id: string | null;
}

export function serializeOrderForApi(order: Order): OrderApiObject {
  return {
    id: order.id,
    status: order.status,
    currency: order.currency,
    subtotal_cents: order.subtotalCents,
    total_cents: order.totalCents,
    refunded_cents: order.refundedCents,
    line_items: order.lineItems.map((li) => ({
      product_id: li.productId,
      name: li.name,
      unit_price_cents: li.unitPriceCents,
      quantity: li.quantity,
      is_bump: li.isBump,
    })),
    contact_id: order.contactId,
    checkout_page_id: order.checkoutPageId,
    quote_id: order.quoteId ?? null,
    event_id: order.eventId ?? null,
    purchase_id: order.purchaseId ?? null,
    source: order.source,
    livemode: order.livemode,
    buyer_email: order.buyerEmail,
    buyer_name: order.buyerName,
    stripe_checkout_session_id: order.stripeCheckoutSessionId,
    stripe_payment_intent_id: order.stripePaymentIntentId,
  };
}

/**
 * Pending order created with the checkout session, before the buyer reaches
 * Stripe, so the webhook always has a row to reconcile. An unattributable payment
 * is far worse than an abandoned pending row.
 */
export async function createPendingOrder(input: {
  agencyId: string;
  subAccountId: string;
  contactId: string | null;
  checkoutPageId: string | null;
  quoteId?: string | null;
  eventId?: string | null;
  communityGroupId?: string | null;
  purchaseId?: string | null;
  source: OrderSource;
  currency: string;
  lineItems: OrderLineItem[];
  stripeCheckoutSessionId: string;
  livemode: boolean;
  buyerEmail: string | null;
  buyerName: string | null;
  attribution: ContactAttribution | null;
  productLinkProductId?: string | null;
  websiteRef?: OrderWebsiteRef | null;
  deliveries?: OrderDeliverySnapshot[];
}): Promise<string> {
  if (input.lineItems.length === 0) {
    throw new OrderError("An order needs at least one line item.");
  }
  const subtotalCents = computeOrderSubtotalCents(input.lineItems);
  if (subtotalCents <= 0) {
    throw new OrderError("Order total must be greater than zero.");
  }

  const ref = getAdminDb().collection("orders").doc();
  await ref.set({
    agencyId: input.agencyId,
    subAccountId: input.subAccountId,
    contactId: input.contactId,
    checkoutPageId: input.checkoutPageId,
    quoteId: input.quoteId ?? null,
    eventId: input.eventId ?? null,
    communityGroupId: input.communityGroupId ?? null,
    purchaseId: input.purchaseId ?? null,
    source: input.source,
    status: "pending",
    currency: input.currency.toLowerCase(),
    lineItems: input.lineItems,
    subtotalCents,
    // No tax/shipping/discounts yet; separate field so adding them later doesn't
    // mean rewriting old orders.
    totalCents: subtotalCents,
    refundedCents: 0,
    stripeCheckoutSessionId: input.stripeCheckoutSessionId,
    stripePaymentIntentId: null,
    livemode: input.livemode,
    buyerEmail: input.buyerEmail,
    buyerName: input.buyerName,
    attribution: input.attribution,
    // Written only when set, so orders from every other path are unchanged.
    ...(input.productLinkProductId
      ? { productLinkProductId: input.productLinkProductId }
      : {}),
    ...(input.websiteRef ? { websiteRef: input.websiteRef } : {}),
    ...(input.deliveries?.length ? { deliveries: input.deliveries } : {}),
    createdAt: FieldValue.serverTimestamp(),
    paidAt: null,
    updatedAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

/** By Checkout Session id (the reconciler's idempotency key). Equality only, no index. */
export async function findOrderByCheckoutSession(
  sessionId: string,
): Promise<Order | null> {
  const snap = await getAdminDb()
    .collection("orders")
    .where("stripeCheckoutSessionId", "==", sessionId)
    .limit(1)
    .get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...(doc.data() as Omit<Order, "id">) };
}

/** By PaymentIntent, which refunds and disputes reference. */
export async function findOrderByPaymentIntent(
  paymentIntentId: string,
): Promise<Order | null> {
  const snap = await getAdminDb()
    .collection("orders")
    .where("stripePaymentIntentId", "==", paymentIntentId)
    .limit(1)
    .get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...(doc.data() as Omit<Order, "id">) };
}

/**
 * Mark paid. Idempotent: Stripe redelivers checkout.session.completed, and a
 * double fire would mean duplicate order.paid webhooks, enrollments and activity.
 * Returns false if already paid or terminal so the caller skips side effects.
 */
export async function markOrderPaid(input: {
  orderId: string;
  stripePaymentIntentId: string | null;
  buyerEmail?: string | null;
  buyerName?: string | null;
}): Promise<{ changed: boolean; order: Order | null }> {
  const db = getAdminDb();
  const ref = db.doc(`orders/${input.orderId}`);

  // Transaction so two concurrent deliveries can't both win.
  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { changed: false, order: null as Order | null };
    const order = { id: snap.id, ...(snap.data() as Omit<Order, "id">) };

    if (order.status === "paid" || isOrderTerminal(order.status)) {
      return { changed: false, order };
    }

    const patch: Record<string, unknown> = {
      status: "paid",
      paidAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (input.stripePaymentIntentId) {
      patch.stripePaymentIntentId = input.stripePaymentIntentId;
    }
    // Stripe has the real email; the pre-checkout form may not.
    if (input.buyerEmail && !order.buyerEmail) patch.buyerEmail = input.buyerEmail;
    if (input.buyerName && !order.buyerName) patch.buyerName = input.buyerName;

    tx.update(ref, patch);
    return {
      changed: true,
      order: {
        ...order,
        status: "paid" as const,
        stripePaymentIntentId:
          input.stripePaymentIntentId ?? order.stripePaymentIntentId,
        buyerEmail: order.buyerEmail ?? input.buyerEmail ?? null,
        buyerName: order.buyerName ?? input.buyerName ?? null,
      },
    };
  });

  return result;
}

/** Idempotent too: charge.refunded can arrive twice and refunds are cumulative. */
export async function recordOrderRefund(input: {
  orderId: string;
  /** Total refunded on the charge so far (Stripe's figure), not the delta. */
  refundedCentsTotal: number;
}): Promise<{ changed: boolean; order: Order | null }> {
  const db = getAdminDb();
  const ref = db.doc(`orders/${input.orderId}`);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { changed: false, order: null as Order | null };
    const order = { id: snap.id, ...(snap.data() as Omit<Order, "id">) };

    // Stripe sends the running total, so an equal value is a replay.
    if (input.refundedCentsTotal <= order.refundedCents) {
      return { changed: false, order };
    }

    const status =
      input.refundedCentsTotal >= order.totalCents
        ? ("refunded" as const)
        : ("partially_refunded" as const);

    tx.update(ref, {
      refundedCents: input.refundedCentsTotal,
      status,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return {
      changed: true,
      order: { ...order, refundedCents: input.refundedCentsTotal, status },
    };
  });
}

/**
 * Downstream effects of an order change. Fire-and-forget: a failure must never
 * break the reconciler, or Stripe would retry an already-recorded payment.
 */
export function emitOrderEvents(opts: {
  order: Order;
  type: WebhookEventType;
  activity: { type: "order_paid" | "order_refunded"; content: string } | null;
}): void {
  // Work continues after awaits, so schedule the whole block up front or Vercel
  // can freeze it mid-way.
  runAfterResponse(async () => {
    const wire = serializeOrderForApi(opts.order);

    try {
      await emitWebhookEvent({
        subAccountId: opts.order.subAccountId,
        agencyId: opts.order.agencyId,
        // Test-mode keys produce test events; live-only subscribers ignore them.
        mode: opts.order.livemode ? "live" : "test",
        type: opts.type,
        payload: { order: wire },
      });
    } catch (err) {
      console.warn("[orders-service] webhook emit failed", err);
    }

    // No contact yet: the webhook above still fires, but nobody to enroll.
    if (!opts.order.contactId) return;

    if (opts.type === "order.paid") {
      try {
        await fireWorkflowTrigger({
          subAccountId: opts.order.subAccountId,
          agencyId: opts.order.agencyId,
          type: "order.paid",
          contactId: opts.order.contactId,
          context: { orderId: opts.order.id, totalCents: opts.order.totalCents },
        });
      } catch (err) {
        console.warn("[orders-service] workflow trigger failed", err);
      }
    }

    if (opts.activity) {
      try {
        await getAdminDb()
          .collection("contacts")
          .doc(opts.order.contactId)
          .collection("activities")
          .add({
            type: opts.activity.type,
            content: opts.activity.content,
            createdBy: "system",
            meta: { orderId: opts.order.id },
            createdAt: FieldValue.serverTimestamp(),
          });
      } catch (err) {
        console.warn("[orders-service] activity write failed", err);
      }
    }
  });
}
