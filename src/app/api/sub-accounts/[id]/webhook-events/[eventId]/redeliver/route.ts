import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import {
  createDelivery,
  getEvent,
} from "@/lib/firestore/webhook-events";
import {
  getSubscription,
} from "@/lib/firestore/webhook-subscriptions";
import { scheduleDeliveryRetry } from "@/lib/api/webhooks/dispatch";

/**
 * Replay an archived webhook event to one subscription: { subscriptionId }.
 * One target at a time (like Stripe) because re-firing to every original
 * subscriber re-hits ones that already succeeded. Creates a new delivery
 * (attempt 1) through the normal retry/circuit-breaker path, failure counter
 * included. Admin only; replays re-run the subscriber's handler.
 */

interface ReplayBody {
  subscriptionId?: string;
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string; eventId: string }> },
) {
  const { id: subAccountId, eventId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: ReplayBody;
  try {
    body = (await request.json()) as ReplayBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const subscriptionId = body.subscriptionId?.trim();
  if (!subscriptionId) {
    return NextResponse.json(
      { error: "subscriptionId is required." },
      { status: 400 },
    );
  }

  const [event, subscription] = await Promise.all([
    getEvent(subAccountId, eventId),
    getSubscription(subAccountId, subscriptionId),
  ]);
  if (!event || event.subAccountId !== subAccountId) {
    return NextResponse.json({ error: "Event not found" }, { status: 404 });
  }
  if (!subscription || subscription.subAccountId !== subAccountId) {
    return NextResponse.json({ error: "Subscription not found" }, { status: 404 });
  }
  if (subscription.mode !== event.mode) {
    return NextResponse.json(
      { error: "Subscription mode does not match event mode." },
      { status: 400 },
    );
  }
  if (subscription.status === "paused") {
    return NextResponse.json(
      { error: "Subscription is paused. Resume it before replaying." },
      { status: 400 },
    );
  }

  const delivery = await createDelivery({
    subAccountId,
    agencyId: event.agencyId,
    eventId,
    subscriptionId,
    attempt: 1,
    url: subscription.url,
    scheduledAt: new Date(),
  });
  await scheduleDeliveryRetry({
    subAccountId,
    eventId,
    deliveryId: delivery.id,
    delaySeconds: 0,
  });

  return NextResponse.json({
    ok: true,
    deliveryId: delivery.id,
  });
}
