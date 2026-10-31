import {
  Bot,
  Instagram,
  Mail,
  MessageCircle,
  MessagesSquare,
  MessageSquare,
  PhoneCall,
  PhoneOutgoing,
  Radar,
  Star,
  type LucideIcon,
} from "lucide-react";

/**
 * Source of truth for the AI Agents channels: nav tabs, Overview cards and
 * Coming Soon pages all read this list. "Monitors" is a tab, not a channel:
 * it has no aiAgent/{channel} doc and its agents watch the CRM instead of
 * answering anyone.
 */

export type AiChannelId =
  | "overview"
  | "sms"
  | "whatsapp"
  | "meta"
  | "voice"
  | "email"
  | "web-chat"
  | "google-business"
  | "outbound"
  | "monitors";

/** Inbound: the AI reacts to someone. Outbound: the AI calls out. Monitor: the AI watches the CRM. Coloured differently in the nav. */
export type AiChannelGroup = "inbound" | "outbound" | "monitor";

export interface AiChannel {
  id: AiChannelId;
  label: string;
  /** Overview cards and the ComingSoon hero. */
  blurb: string;
  icon: LucideIcon;
  /** Drives nav colour; the Overview grid only shows inbound. */
  group: AiChannelGroup;
  /** Render the ComingSoon placeholder instead of real config. */
  comingSoon: boolean;
  /** Left out of nav and Overview; the route still renders ComingSoon if visited directly. */
  hidden?: boolean;
  /** Shows a small "beta" marker on the tab and card. */
  beta?: boolean;
  /** Slug under /sa/{id}/ai-agents/; empty for the Overview. */
  slug: string;
}

export const AI_CHANNELS: AiChannel[] = [
  {
    id: "overview",
    label: "Overview",
    blurb: "Status of every AI agent channel on this sub-account.",
    icon: Bot,
    group: "inbound",
    comingSoon: false,
    slug: "",
  },
  {
    id: "web-chat",
    label: "Web Chat",
    blurb:
      "Own-brand chat widget for your website. AI handles inbound, escalates to a human when needed.",
    icon: MessageCircle,
    group: "inbound",
    comingSoon: false,
    slug: "web-chat",
  },
  {
    id: "sms",
    label: "SMS",
    blurb:
      "AI auto-replies to inbound text messages in real time. Per-sub-account persona, business hours, escalation rules.",
    icon: MessageSquare,
    group: "inbound",
    comingSoon: false,
    slug: "sms",
  },
  {
    id: "whatsapp",
    label: "WhatsApp",
    blurb:
      "AI auto-replies to inbound WhatsApp messages via your Twilio WhatsApp sender. Same persona, business hours, and escalation rules as SMS.",
    icon: MessagesSquare,
    group: "inbound",
    comingSoon: false,
    beta: true,
    slug: "whatsapp",
  },
  {
    id: "meta",
    label: "Messenger & Instagram",
    blurb:
      "AI auto-replies to Facebook Messenger and Instagram DMs on the connected Meta Page. Same persona, business hours, and escalation rules as SMS.",
    icon: Instagram,
    group: "inbound",
    comingSoon: false,
    beta: true,
    slug: "meta",
  },
  {
    id: "voice",
    label: "Voice",
    blurb:
      "AI answers inbound voice calls, qualifies the lead, and books a callback. Same persona as your SMS agent.",
    icon: PhoneCall,
    group: "inbound",
    comingSoon: false,
    slug: "voice",
  },
  {
    id: "email",
    label: "Email",
    blurb:
      "AI drafts replies to inbound emails for your approval — same brand voice and contact context as SMS. Draft-only: it never sends an email by itself.",
    icon: Mail,
    group: "inbound",
    comingSoon: false,
    slug: "email",
  },
  {
    id: "outbound",
    label: "Outbound Voice",
    blurb:
      "AI proactively calls your contacts with its own persona — one contact at a time or a whole list. Reuses the Voice channel's number.",
    icon: PhoneOutgoing,
    group: "outbound",
    comingSoon: false,
    slug: "outbound",
  },
  {
    id: "monitors",
    label: "Monitors",
    blurb:
      "Background agents that watch the workspace every hour: unanswered customer messages and deals stuck in a stage. Each flag becomes a Task plus a push; they never message customers.",
    icon: Radar,
    group: "monitor",
    comingSoon: false,
    beta: true,
    slug: "monitors",
  },
  {
    id: "google-business",
    label: "Google Business",
    blurb:
      "AI replies to Google Business Profile reviews and Q&A. Keeps your reputation responsive without manual work.",
    icon: Star,
    group: "inbound",
    comingSoon: true,
    hidden: true,
    slug: "google-business",
  },
];

export function getChannel(id: AiChannelId): AiChannel {
  const found = AI_CHANNELS.find((c) => c.id === id);
  if (!found) throw new Error(`Unknown AI channel: ${id}`);
  return found;
}

/** Channels shown in nav and Overview. Hidden ones still resolve by URL. */
export const VISIBLE_AI_CHANNELS: AiChannel[] = AI_CHANNELS.filter(
  (c) => !c.hidden,
);

/**
 * The Monitors tab follows the agency's hide-vs-Locked choice like a sidebar
 * entry: with the gate off it's hidden unless the owner explicitly chose
 * "show as Locked" (an explicit false). Other channels are never hidden here.
 */
export function monitorsTabVisible(
  channel: Pick<AiChannel, "id">,
  sub:
    | { agentsEnabledByAgency?: boolean; agentsHiddenWhenDisabled?: boolean }
    | null
    | undefined,
): boolean {
  if (channel.id !== "monitors") return true;
  if (!sub) return true;
  if (sub.agentsEnabledByAgency === true) return true;
  return sub.agentsHiddenWhenDisabled === false;
}

export function buildChannelHref(
  subAccountId: string,
  channel: AiChannel,
): string {
  const base = `/sa/${subAccountId}/ai-agents`;
  return channel.slug ? `${base}/${channel.slug}` : base;
}

export { Bot as AiAgentsIcon };
