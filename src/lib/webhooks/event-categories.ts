import type { WebhookEventType } from "@/types/webhooks";

/**
 * Webhook event categories, shared by the picker UI and server-side
 * validation. A subscription targets exactly one category; more categories
 * means more webhooks. Type-only import, so safe in client components.
 */

export interface WebhookEventCategory {
  label: string;
  events: WebhookEventType[];
}

export const WEBHOOK_EVENT_CATEGORIES: WebhookEventCategory[] = [
  {
    label: "Contacts",
    events: ["contact.created", "contact.updated", "contact.deleted"],
  },
  {
    label: "Deals",
    events: [
      "deal.created",
      "deal.updated",
      "deal.deleted",
      "deal.stage.changed",
      "deal.won",
      "deal.lost",
    ],
  },
  {
    label: "Tasks & Events",
    events: ["task.created", "task.completed", "event.created"],
  },
  { label: "Forms", events: ["form.submitted"] },
  {
    label: "Quotes",
    events: [
      "quote.sent",
      "quote.viewed",
      "quote.accepted",
      "quote.declined",
      "quote.paid",
    ],
  },
  { label: "Bookings", events: ["booking.created", "booking.cancelled"] },
  {
    label: "AI Agents",
    events: [
      "voice.call.completed",
      "voice.call.captured",
      "webchat.lead.captured",
    ],
  },
  {
    label: "Workspace",
    events: ["member.invited", "member.added", "automation.completed"],
  },
  {
    label: "Conversations",
    events: ["message.received", "call.missed"],
  },
  // Required, not cosmetic: eventsAreSingleCategory() fails any event categoryOf()
  // doesn't know, which breaks every subscription containing it. TypeScript
  // won't catch a missing entry, so add the category with every new event type.
  {
    label: "Payments",
    events: ["order.paid", "order.refunded"],
  },
];

/** null if uncategorized. */
export function categoryOf(ev: WebhookEventType): string | null {
  return (
    WEBHOOK_EVENT_CATEGORIES.find((c) => c.events.includes(ev))?.label ?? null
  );
}

/** null when none/empty. */
export function activeCategoryOf(
  events: Iterable<WebhookEventType>,
): string | null {
  for (const ev of events) {
    const c = categoryOf(ev);
    if (c) return c;
  }
  return null;
}

/**
 * Empty list passes (legacy "all events" wildcard; routes decide whether to
 * allow it). Any unknown event fails.
 */
export function eventsAreSingleCategory(events: WebhookEventType[]): boolean {
  if (events.length === 0) return true;
  const first = categoryOf(events[0]);
  if (first === null) return false;
  return events.every((ev) => categoryOf(ev) === first);
}
