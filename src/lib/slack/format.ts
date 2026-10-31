import type { EmitWebhookEventInput } from "@/lib/api/webhooks/dispatch";
import { categoryOf } from "@/lib/webhooks/event-categories";
import type { SlackMessage } from "@/lib/slack/client";

/**
 * Block Kit message per event: a bold one-liner, a short context line and
 * one "Open in LeadStack" button. Payloads are the serialized API resources
 * (`unknown`), so every read is defensive and shape drift degrades the copy,
 * never throws. Events without a specific layout get a generic line.
 */

const SOURCE_LABELS: Record<string, string> = {
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
  email: "Email",
};

const CHANNEL_LABELS: Record<string, string> = {
  sms: "SMS",
  whatsapp: "WhatsApp",
  messenger: "Messenger",
  instagram: "Instagram",
  email: "Email",
  "web-chat": "Web chat",
};

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
/**
 * Slack mrkdwn has no escape sequence, so the characters that would break
 * the bold headline are dropped. Underscores stay: they only italicise at
 * word boundaries and are common in email addresses.
 */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[*~`]/g, "");
}
function money(total: unknown, currency: unknown, fixed = false): string | null {
  const t = num(total);
  if (t === null) return null;
  const c = str(currency)?.toUpperCase();
  const n = t.toLocaleString(
    "en-US",
    fixed ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : undefined,
  );
  return `${c ? `${c} ` : ""}${n}`;
}
/** Stripe-style integer cents to major units. */
function cents(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : n / 100;
}
/** Stage ids are slugs; the payload carries no label. */
function humanize(slug: string): string {
  const s = slug.replace(/[-_]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function when(iso: unknown, tz: unknown): string | null {
  const s = str(iso);
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  const opts: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  };
  const zone = str(tz);
  try {
    return d.toLocaleString("en-US", zone ? { ...opts, timeZone: zone } : opts);
  } catch {
    // An unknown IANA zone throws; fall back to the server zone.
    return d.toLocaleString("en-US", opts);
  }
}

interface Built {
  headline: string;
  context: string | null;
  /** App-relative deep link. */
  path: string;
}

function build(input: EmitWebhookEventInput): Built {
  const sa = input.subAccountId;
  const p = rec(input.payload);

  switch (input.type) {
    case "contact.created": {
      const c = rec(p.contact);
      const id = str(c.id);
      const source = str(c.source);
      const label = source
        ? (SOURCE_LABELS[source] ?? source.charAt(0).toUpperCase() + source.slice(1))
        : null;
      return {
        headline: `New lead: ${esc(str(c.name) ?? "New contact")}`,
        context: [label, str(c.email), str(c.phone)].filter(Boolean).map((x) => esc(x!)).join(" · ") || null,
        path: id ? `/sa/${sa}/contacts/${id}` : `/sa/${sa}/contacts`,
      };
    }
    case "message.received": {
      const m = rec(p.message);
      const contactId = str(m.contact_id);
      const channel = str(m.channel);
      const name = esc(str(m.contact_name) ?? "Unknown contact");
      const preview = str(m.preview);
      return {
        headline: `${name} replied${channel ? ` on ${CHANNEL_LABELS[channel] ?? channel}` : ""}`,
        context: preview ? `“${esc(preview.slice(0, 200))}”` : null,
        path: contactId ? `/sa/${sa}/conversations/${contactId}` : `/sa/${sa}/conversations`,
      };
    }
    case "booking.created":
    case "booking.cancelled": {
      const b = rec(p.booking);
      const title = esc(str(b.title) ?? "Booking");
      const at = when(b.start_at, b.timezone);
      return {
        headline: input.type === "booking.created" ? `New booking: ${title}` : `Booking cancelled: ${title}`,
        context: at,
        path: `/sa/${sa}/calendar`,
      };
    }
    case "call.missed": {
      const c = rec(p.call);
      const contactId = str(c.contact_id);
      return {
        headline: `Missed call from ${esc(str(c.contact_name) ?? str(c.from) ?? "unknown caller")}`,
        context: str(c.contact_name) && str(c.from) ? esc(str(c.from)!) : null,
        path: contactId ? `/sa/${sa}/contacts/${contactId}` : `/sa/${sa}/contacts`,
      };
    }
    case "quote.sent":
    case "quote.viewed":
    case "quote.accepted":
    case "quote.declined":
    case "quote.paid": {
      const q = rec(p.quote);
      const id = str(q.id);
      const kind = str(q.kind) === "invoice" ? "Invoice" : "Quote";
      const verb = {
        "quote.sent": "sent",
        "quote.viewed": "opened by the recipient",
        "quote.accepted": rec(q.signature).signer_name ? "signed" : "accepted",
        "quote.declined": "declined",
        "quote.paid": "paid",
      }[input.type];
      const signer = str(rec(q.signature).signer_name);
      return {
        headline: `${kind} ${esc(str(q.number) ?? "")} ${verb}`.replace(/\s+/g, " "),
        context: [money(q.total, q.currency), signer ? `signed by ${esc(signer)}` : null, str(q.decline_reason) ? esc(str(q.decline_reason)!) : null]
          .filter(Boolean)
          .join(" · ") || null,
        path: id ? `/sa/${sa}/quotes/${id}` : `/sa/${sa}/quotes`,
      };
    }
    case "deal.created":
    case "deal.stage.changed":
    case "deal.won":
    case "deal.lost": {
      const d = rec(p.deal);
      const title = esc(str(d.title) ?? "Deal");
      const stage = str(d.stage);
      const who = str(rec(p.contact).name);
      const verb = {
        "deal.created": "created",
        "deal.stage.changed": stage ? `moved to ${esc(humanize(stage))}` : "moved",
        "deal.won": "won",
        "deal.lost": "lost",
      }[input.type];
      return {
        headline: `Deal ${verb}: ${title}`,
        context: [money(d.value, d.currency), who ? esc(who) : null].filter(Boolean).join(" · ") || null,
        path: `/sa/${sa}/pipeline`,
      };
    }
    case "form.submitted": {
      // The payload carries the serialized contact, not the form's name.
      const c = rec(rec(p.submission).contact);
      const contactId = str(c.id);
      const name = str(c.name);
      return {
        headline: `Form submitted${name ? ` by ${esc(name)}` : ""}`,
        context: [str(c.email), str(c.phone)].filter(Boolean).map((x) => esc(x!)).join(" · ") || null,
        path: contactId ? `/sa/${sa}/contacts/${contactId}` : `/sa/${sa}/forms`,
      };
    }
    case "task.created":
    case "task.completed": {
      const t = rec(p.task);
      return {
        headline: `${input.type === "task.created" ? "New task" : "Task completed"}: ${esc(str(t.title) ?? "task")}`,
        context: null,
        path: `/sa/${sa}/tasks`,
      };
    }
    case "order.paid":
    case "order.refunded": {
      const o = rec(p.order);
      const amount = money(
        cents(input.type === "order.refunded" ? o.refunded_cents : o.total_cents),
        o.currency,
        true,
      );
      const buyer = str(o.buyer_name) ?? str(o.buyer_email);
      return {
        headline: input.type === "order.paid" ? "Order paid" : "Order refunded",
        context: [amount, buyer ? esc(buyer) : null].filter(Boolean).join(" · ") || null,
        path: `/sa/${sa}/reports`,
      };
    }
    case "voice.call.captured":
    case "webchat.lead.captured": {
      // Voice nests contact_id under call; web chat puts it at the top level.
      const c = rec(p.captured);
      const id = str(p.contact_id) ?? str(rec(p.call).contact_id);
      return {
        headline: `${input.type === "voice.call.captured" ? "Voice agent" : "Web chat"} captured a lead: ${esc(str(c.name) ?? "new contact")}`,
        context: [str(c.email), str(c.phone)].filter(Boolean).map((x) => esc(x!)).join(" · ") || null,
        path: id ? `/sa/${sa}/contacts/${id}` : `/sa/${sa}/contacts`,
      };
    }
    default: {
      const category = categoryOf(input.type);
      return {
        headline: `${category ? `${category}: ` : ""}${input.type.replace(/\./g, " ")}`,
        context: null,
        path: `/sa/${sa}/dashboard`,
      };
    }
  }
}

export function buildSlackMessage(
  input: EmitWebhookEventInput,
  appUrl: string | null,
): SlackMessage {
  const built = build(input);
  const text = built.context ? `${built.headline} — ${built.context}` : built.headline;
  const blocks: unknown[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*${built.headline}*${built.context ? `\n${built.context}` : ""}` },
    },
  ];
  if (appUrl) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Open in LeadStack" },
          url: `${appUrl}${built.path}`,
        },
      ],
    });
  }
  return { text, blocks };
}

export function slackTestMessage(appUrl: string | null, subAccountId: string): SlackMessage {
  const text = "LeadStack is connected to this channel. Notifications will appear here.";
  const blocks: unknown[] = [
    { type: "section", text: { type: "mrkdwn", text: `*${text}*` } },
  ];
  if (appUrl) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Open in LeadStack" },
          url: `${appUrl}/sa/${subAccountId}/dashboard/settings`,
        },
      ],
    });
  }
  return { text, blocks };
}
