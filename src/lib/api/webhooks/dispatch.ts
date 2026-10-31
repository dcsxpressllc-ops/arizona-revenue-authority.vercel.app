import "server-only";

import { publishCallback } from "@/lib/automations/qstash";
import {
  createDelivery,
  createEvent,
} from "@/lib/firestore/webhook-events";
import { findMatchingSubscriptions } from "@/lib/firestore/webhook-subscriptions";
import { dispatchPushForWebhookEvent } from "@/lib/push/events";
import { dispatchSlackForWebhookEvent } from "@/lib/slack/events";
import { runAfterResponse } from "@/lib/server/after-response";
import type { WebhookEventType } from "@/types/webhooks";

/**
 * Emit a webhook event after a successful resource write. Fire-and-forget:
 * subscriber endpoints can be slow, down or untrusted, so they never sit in the
 * write path. Failures are logged and can be replayed manually.
 *
 *   void emitWebhookEvent({
 *     subAccountId: ctx.subAccountId,
 *     agencyId: ctx.agencyId,
 *     mode: ctx.mode,
 *     type: "contact.created",
 *     payload: { contact: serializeContactForApi(c) },
 *   });
 */

const DELIVERY_DISPATCH_PATH = "/api/webhooks-out/step";

export interface EmitWebhookEventInput {
  subAccountId: string;
  agencyId: string;
  mode: "live" | "test";
  type: WebhookEventType;
  /** Already-serialized resource; sent to subscribers as-is. */
  payload: unknown;
}

export async function emitWebhookEvent(
  input: EmitWebhookEventInput,
): Promise<void> {
  // Serverless hosts freeze the function once the response is sent, which would
  // cut off web-push and the QStash fan-out. runAfterResponse keeps it alive via
  // after(), falling back to plain fire-and-forget outside a request scope.
  // runEmitWebhookEvent catches everything, so neither path rejects.
  runAfterResponse(() => runEmitWebhookEvent(input));
}

async function runEmitWebhookEvent(
  input: EmitWebhookEventInput,
): Promise<void> {
  try {
    // Push notifications ride the same event stream, and run before the
    // no-subscribers early return since most deployments have no API webhooks.
    // Awaited so after() stays alive for the web-push call. Self-guarded (event
    // filter, VAPID check, swallows errors). Test mode never notifies a phone.
    if (input.mode === "live") {
      // Slack rides the same stream; it reads its own config and self-guards.
      // Both are independent, so they run side by side.
      await Promise.all([
        dispatchPushForWebhookEvent(input),
        dispatchSlackForWebhookEvent(input),
      ]);
    }

    const subscriptions = await findMatchingSubscriptions(
      input.subAccountId,
      input.mode,
      input.type,
    );

    if (subscriptions.length === 0) {
      // Nobody's subscribed, so skip the event archive row too; it only exists for replay.
      return;
    }

    const event = await createEvent({
      subAccountId: input.subAccountId,
      agencyId: input.agencyId,
      mode: input.mode,
      type: input.type,
      payload: input.payload,
      subscriptionIds: subscriptions.map((s) => s.id),
    });

    // One delivery per subscription, no delay. The worker reschedules retries with backoff.
    await Promise.all(
      subscriptions.map(async (sub) => {
        const delivery = await createDelivery({
          subAccountId: input.subAccountId,
          agencyId: input.agencyId,
          eventId: event.id,
          subscriptionId: sub.id,
          attempt: 1,
          url: sub.url,
          scheduledAt: new Date(),
        });
        await publishCallback({
          pathname: DELIVERY_DISPATCH_PATH,
          body: {
            subAccountId: input.subAccountId,
            eventId: event.id,
            deliveryId: delivery.id,
          },
          delaySeconds: 0,
          deduplicationId: `${event.id}_${delivery.id}`,
        });
      }),
    );
  } catch (err) {
    // Caught here so callers can safely `void` this.
    console.warn("[webhooks/dispatch] emitWebhookEvent failed", err);
  }
}

/**
 * Schedule the next attempt; caller picks the delay. The dedup id needs to
 * differ from attempt 1 or QStash drops the retry.
 */
export async function scheduleDeliveryRetry(opts: {
  subAccountId: string;
  eventId: string;
  deliveryId: string;
  delaySeconds: number;
}): Promise<void> {
  await publishCallback({
    pathname: DELIVERY_DISPATCH_PATH,
    body: {
      subAccountId: opts.subAccountId,
      eventId: opts.eventId,
      deliveryId: opts.deliveryId,
    },
    delaySeconds: opts.delaySeconds,
    // Each retry gets a fresh delivery row, so the delivery id keeps the dedup key unique.
    deduplicationId: `${opts.eventId}_${opts.deliveryId}`,
  });
}
