/**
 * Outbound webhooks for the public API. Each matching subscription gets its
 * own delivery, signed Stripe-style with `LeadStack-Signature`.
 *
 * Collections under `subAccounts/{id}/`:
 *   webhookSubscriptions/{subId}  - URL, signing secret, breaker counters (server-only)
 *   webhookEvents/{eventId}       - append-only, keeps the payload for manual replay
 *   webhookEvents/{eventId}/deliveries/{deliveryId} - one row per attempt
 *
 * `mode` mirrors API keys: test subscriptions only see test-mode events and
 * live ones never do.
 */

export type WebhookSubscriptionStatus = "active" | "paused";

/**
 * Event registry, `<resource>.<verb>` like Stripe. `.updated` fires on every
 * PATCH; finer verbs (`deal.stage.changed`) exist where subscribers want them.
 * To add one: append it here, call emitEvent() from its write path, document it in /docs/api.
 */
export const WEBHOOK_EVENT_TYPES = [
  "contact.created",
  "contact.updated",
  "contact.deleted",
  "deal.created",
  "deal.updated",
  "deal.deleted",
  "deal.stage.changed",
  "deal.won",
  "deal.lost",
  "task.created",
  "task.completed",
  "event.created",
  "form.submitted",
  "quote.sent",
  "quote.viewed",
  "quote.accepted",
  "quote.declined",
  "quote.paid",
  "booking.created",
  "booking.cancelled",
  // Emitted from dashboard write paths too, not just the API. Live-only.
  "voice.call.completed",
  "voice.call.captured",
  "webchat.lead.captured",
  "member.invited",
  // An existing account added directly (no signup); member.invited covers new invitees.
  "member.added",
  "automation.completed",
  // From the unified-inbox write (every inbound SMS/WhatsApp/Messenger/
  // Instagram/email) and the missed-call handler. Also drive push alerts.
  // Live-only: they come from provider webhooks.
  "message.received",
  "call.missed",
  "community.member.joined",
  "community.member.approved",
  "community.purchase.paid",
  "community.lesson.completed",
  "community.course.completed",
  // Agency -> sub-account plan lifecycle. Live-only; billing has no test mode.
  "billing.plan.assigned",
  "billing.activated",
  "billing.past_due",
  "billing.canceled",
  // One-time agency -> client charge paid.
  "billing.charge.paid",
  // The sub-account's own customers paying it through its connected Stripe
  // (not the billing.* events, which are the agency charging the sub-account).
  // Emitted by lib/stripe/order-reconciler.ts; test mode when the key is rk_test_.
  "order.paid",
  "order.refunded",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export interface WebhookSubscriptionDoc {
  id: string;
  subAccountId: string;
  agencyId: string;
  mode: "live" | "test";
  /** Must be https:// in production. */
  url: string;
  /** Operator label, e.g. "Zapier sync". */
  description: string | null;
  /** Empty = every event (legal, discouraged). */
  events: WebhookEventType[];
  /**
   * Stored raw so the dispatcher can sign; shown to the subscriber once.
   * Rules deny all client access to this collection.
   */
  signingSecret: string;
  status: WebhookSubscriptionStatus;
  /** Reset on any success; the breaker auto-pauses at 10. */
  consecutiveFailures: number;
  lastDeliveryAt: Date | null;
  lastDeliveryStatus: number | null;
  lastErrorAt: Date | null;
  lastErrorMessage: string | null;
  pausedAt: Date | null;
  pausedReason: "circuit_breaker" | "manual" | null;
  createdByUid: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Management API shape. No `signingSecret` except in the create response. */
export interface WebhookSubscriptionResponse {
  id: string;
  mode: "live" | "test";
  url: string;
  description: string | null;
  events: WebhookEventType[];
  status: WebhookSubscriptionStatus;
  consecutiveFailures: number;
  lastDeliveryAt: string | null;
  lastDeliveryStatus: number | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
  pausedAt: string | null;
  pausedReason: WebhookSubscriptionDoc["pausedReason"];
  createdAt: string;
  /** Create response only. */
  signingSecret?: string;
}

export type WebhookDeliveryStatus =
  | "pending"
  | "succeeded"
  | "failed"
  | "exhausted";

export interface WebhookEventDoc {
  id: string;
  subAccountId: string;
  agencyId: string;
  mode: "live" | "test";
  type: WebhookEventType;
  /** Already serialized; replay reuses the exact wire shape. */
  payload: unknown;
  /** Matched at emit time. */
  subscriptionIds: string[];
  createdAt: Date;
  /** 90 days; reaped by the cleanup cron. */
  expiresAt: Date;
}

export interface WebhookDeliveryDoc {
  id: string;
  eventId: string;
  subscriptionId: string;
  subAccountId: string;
  agencyId: string;
  /** 1-indexed. */
  attempt: number;
  /** Snapshot, so later URL edits don't rewrite history. */
  url: string;
  status: WebhookDeliveryStatus;
  httpStatus: number | null;
  /** First 2KB. */
  responseBody: string | null;
  responseHeaders: string | null;
  /** Network error, non-2xx, timeout. */
  errorMessage: string | null;
  scheduledAt: Date;
  attemptedAt: Date | null;
  nextRetryAt: Date | null;
}

/** One attempt in Logs -> Webhooks (ISO timestamps). */
export interface WebhookDeliveryLogResponse {
  id: string;
  subscriptionId: string;
  url: string;
  attempt: number;
  status: WebhookDeliveryStatus;
  httpStatus: number | null;
  errorMessage: string | null;
  responseBody: string | null;
  scheduledAt: string;
  attemptedAt: string | null;
  nextRetryAt: string | null;
}

/** One event with nested attempts, from listRecentEventsWithDeliveries(). */
export interface WebhookEventLogResponse {
  id: string;
  type: WebhookEventType;
  mode: "live" | "test";
  createdAt: string;
  /** Matched at emit time. */
  subscriptionCount: number;
  deliveries: WebhookDeliveryLogResponse[];
}
