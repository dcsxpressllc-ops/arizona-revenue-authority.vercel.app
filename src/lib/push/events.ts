import "server-only";

import { sendPushForEvent } from "@/lib/push/send";
import type { EmitWebhookEventInput } from "@/lib/api/webhooks/dispatch";

/**
 * Push consumer on the webhook event stream. Hooked in at emitWebhookEvent
 * before the no-subscriptions early return, so pushes fire even with no
 * external webhooks. The four speed-to-lead events and the two quote outcomes
 * notify; the rest are no-ops. Payloads are `unknown`, so reads are defensive:
 * shape drift degrades the copy, never throws.
 */

const NEW_LEAD_SOURCE_LABELS: Record<string, string> = {
  "website-form": "Website form",
  "web-chat": "Web chat",
  "booking-page": "Booking page",
  community: "Community",
  website: "Website",
  referral: "Referral",
  ads: "Ads",
  facebook: "Facebook",
  instagram: "Instagram",
  whatsapp: "WhatsApp",
  voice: "Voice",
};

const CHANNEL_LABELS: Record<string, string> = {
  sms: "SMS",
  whatsapp: "WhatsApp",
  messenger: "Messenger",
  instagram: "Instagram",
  email: "Email",
};

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

export async function dispatchPushForWebhookEvent(
  input: EmitWebhookEventInput,
): Promise<void> {
  try {
    const payload = rec(input.payload);
    const base = {
      subAccountId: input.subAccountId,
      agencyId: input.agencyId,
    };

    switch (input.type) {
      case "contact.created": {
        const contact = rec(payload.contact);
        const id = str(contact.id);
        const name = str(contact.name) ?? "New contact";
        const source = str(contact.source);
        const sourceLabel = source
          ? (NEW_LEAD_SOURCE_LABELS[source] ??
            source.charAt(0).toUpperCase() + source.slice(1))
          : null;
        await sendPushForEvent({
          ...base,
          title: "New lead",
          body: sourceLabel ? `${name} · ${sourceLabel}` : name,
          url: id
            ? `/sa/${input.subAccountId}/contacts/${id}`
            : `/sa/${input.subAccountId}/contacts`,
          tag: id ? `lead-${id}` : undefined,
          territoryId: str(contact.territory_id),
        });
        return;
      }
      case "booking.created": {
        const booking = rec(payload.booking);
        const title = str(booking.title) ?? "New booking";
        const startAt = str(booking.start_at);
        // Booking page timezone from the payload; otherwise toLocaleString uses the
        // server zone (UTC in prod) and shows the wrong time.
        const tz = str(booking.timezone);
        const when = startAt
          ? new Date(startAt).toLocaleString("en-US", {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
              ...(tz ? { timeZone: tz } : {}),
            })
          : null;
        await sendPushForEvent({
          ...base,
          title: "New booking",
          body: when ? `${title} · ${when}` : title,
          url: `/sa/${input.subAccountId}/calendar`,
          tag: str(booking.id) ? `booking-${str(booking.id)}` : undefined,
        });
        return;
      }
      case "message.received": {
        const message = rec(payload.message);
        const contactId = str(message.contact_id);
        const name = str(message.contact_name) ?? "Unknown contact";
        const channel = str(message.channel);
        const channelLabel = channel ? CHANNEL_LABELS[channel] : null;
        const preview = str(message.preview) ?? "";
        await sendPushForEvent({
          ...base,
          title: channelLabel ? `${name} · ${channelLabel}` : name,
          body: preview,
          url: contactId
            ? `/sa/${input.subAccountId}/conversations/${contactId}`
            : `/sa/${input.subAccountId}/conversations`,
          // One per conversation, so a burst replaces rather than stacks.
          tag: contactId ? `msg-${contactId}` : undefined,
        });
        return;
      }
      // Accepted is the money moment, declined is the cue to follow up. Not hung off
      // task.created, which also fires for manual/workflow tasks and would double
      // watchdog alerts.
      case "quote.accepted":
      case "quote.declined": {
        const quote = rec(payload.quote);
        const id = str(quote.id);
        const kindLabel = str(quote.kind) === "invoice" ? "Invoice" : "Quote";
        const number = str(quote.number);
        const total = typeof quote.total === "number" ? quote.total : null;
        const currency = str(quote.currency);
        const amount =
          total !== null
            ? `${currency ? `${currency} ` : ""}${total.toLocaleString()}`
            : null;
        await sendPushForEvent({
          ...base,
          title:
            input.type === "quote.accepted"
              ? `${kindLabel} accepted`
              : `${kindLabel} declined`,
          body: [number, amount].filter(Boolean).join(" · ") || kindLabel,
          url: id
            ? `/sa/${input.subAccountId}/quotes/${id}`
            : `/sa/${input.subAccountId}/quotes`,
          tag: id ? `quote-${id}` : undefined,
        });
        return;
      }
      case "call.missed": {
        const call = rec(payload.call);
        const contactId = str(call.contact_id);
        const name = str(call.contact_name);
        const from = str(call.from);
        await sendPushForEvent({
          ...base,
          title: "Missed call",
          body: name || from || "Unknown caller",
          url: contactId
            ? `/sa/${input.subAccountId}/contacts/${contactId}`
            : `/sa/${input.subAccountId}/contacts`,
          tag: contactId ? `call-${contactId}` : undefined,
        });
        return;
      }
      default:
        return;
    }
  } catch (err) {
    console.warn("[push/events] dispatch failed", err);
  }
}
