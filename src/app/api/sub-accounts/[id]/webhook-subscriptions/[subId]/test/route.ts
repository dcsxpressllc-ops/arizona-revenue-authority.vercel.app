import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import {
  createDelivery,
  createEvent,
} from "@/lib/firestore/webhook-events";
import { getSubscription } from "@/lib/firestore/webhook-subscriptions";
import { scheduleDeliveryRetry } from "@/lib/api/webhooks/dispatch";
import { SAMPLE_PAYLOADS } from "@/lib/webhooks/sample-payloads";
import type { WebhookEventType } from "@/types/webhooks";

/**
 * "Send test event" for one subscription, so agencies can check their Zap /
 * Make / custom endpoint before going live. Goes through the same dispatch,
 * signing, retry and delivery log as a real event.
 *
 * Event type: `type` in the body if the subscription listens for it, else
 * its first subscribed type, else `contact.created`. The payload is a sample
 * with obviously fake ids (`contact_test_xxx`); like Stripe, nothing else
 * marks it as a test. Admin only (agency owners count).
 */

interface TestBody {
  type?: WebhookEventType;
}


export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string; subId: string }> },
) {
  const { id: subAccountId, subId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const subscription = await getSubscription(subAccountId, subId);
  if (!subscription || subscription.subAccountId !== subAccountId) {
    return NextResponse.json({ error: "Subscription not found" }, { status: 404 });
  }
  if (subscription.status === "paused") {
    return NextResponse.json(
      {
        error:
          "Subscription is paused. Resume it before sending a test event.",
      },
      { status: 400 },
    );
  }

  let body: TestBody = {};
  try {
    body = (await request.json()) as TestBody;
  } catch {
    // Empty body is fine.
  }

  let type: WebhookEventType;
  if (body.type) {
    if (subscription.events.length > 0 && !subscription.events.includes(body.type)) {
      return NextResponse.json(
        {
          error: `Subscription is not subscribed to '${body.type}'. Add it to the event list first.`,
        },
        { status: 400 },
      );
    }
    type = body.type;
  } else if (subscription.events.length === 0) {
    type = "contact.created";
  } else {
    type = subscription.events[0]!;
  }

  const payload = SAMPLE_PAYLOADS[type]();

  // Stored as a real event + delivery so it shows in the log and can be
  // replayed.
  const event = await createEvent({
    subAccountId,
    agencyId: subscription.agencyId,
    mode: subscription.mode,
    type,
    payload,
    subscriptionIds: [subscription.id],
  });
  const delivery = await createDelivery({
    subAccountId,
    agencyId: subscription.agencyId,
    eventId: event.id,
    subscriptionId: subscription.id,
    attempt: 1,
    url: subscription.url,
    scheduledAt: new Date(),
  });
  await scheduleDeliveryRetry({
    subAccountId,
    eventId: event.id,
    deliveryId: delivery.id,
    delaySeconds: 0,
  });

  return NextResponse.json({
    ok: true,
    eventId: event.id,
    deliveryId: delivery.id,
    type,
    message: `Test event '${type}' dispatched. Check your endpoint within ~10 seconds.`,
  });
}
