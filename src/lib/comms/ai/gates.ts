import type { SubAccountDoc } from "@/types";
import type { ConfiguredChannelId } from "@/lib/comms/ai/agent";

/**
 * Agency gates for AI channels. Each one spends the agency's OpenRouter credits
 * (voice also uses Vapi minutes), so the agency owner decides which a
 * sub-account can run. Same `*EnabledByAgency` pattern as the WhatsApp and
 * outbound voice gates. The PATCH route and every runtime check read through
 * here so they can't drift.
 *
 * Defaults for a missing field differ: SMS, web chat and inbound voice predate
 * the gate and default on (so upgrading never kills a running bot; explicit
 * false locks). WhatsApp and newer channels are opt-in (`=== true`).
 */

/** Gate field and the default applied when it's missing. */
const CHANNEL_GATE: Record<
  ConfiguredChannelId,
  { field: keyof SubAccountDoc; defaultOn: boolean }
> = {
  sms: { field: "smsAgentEnabledByAgency", defaultOn: true },
  "web-chat": { field: "webChatEnabledByAgency", defaultOn: true },
  voice: { field: "inboundVoiceEnabledByAgency", defaultOn: true },
  whatsapp: { field: "whatsappEnabledByAgency", defaultOn: false },
  // Opt-in. The bot also needs metaInboxEnabledByAgency; that's checked where this is read.
  meta: { field: "metaAgentEnabledByAgency", defaultOn: false },
  // Reuses the email-domain gate since the channel only exists via the two-way
  // inbox. Also needs `resendConfig.inboxEnabled` on a verified domain
  // (emailInboxEnabled()), checked where this is read.
  email: { field: "emailDomainEnabledByAgency", defaultOn: false },
};

/**
 * `voice` is the inbound gate; outbound voice uses `outboundVoiceEnabledByAgency`
 * at the call/campaign routes. An explicit boolean always wins over the default.
 */
export function aiChannelGateOn(
  sub: Pick<
    SubAccountDoc,
    | "smsAgentEnabledByAgency"
    | "webChatEnabledByAgency"
    | "inboundVoiceEnabledByAgency"
    | "whatsappEnabledByAgency"
    | "metaAgentEnabledByAgency"
    | "emailDomainEnabledByAgency"
  >,
  channelId: ConfiguredChannelId,
): boolean {
  const { field, defaultOn } = CHANNEL_GATE[channelId];
  const value = (sub as Record<string, unknown>)[field];
  if (value === true) return true;
  if (value === false) return false;
  return defaultOn;
}

/**
 * True if any AI channel is enabled. Gates the shared endpoints that spend
 * tokens/Firecrawl without belonging to a channel ("Test this persona", website
 * KB refresh).
 */
export function anyAiChannelGateOn(
  sub: Pick<
    SubAccountDoc,
    | "smsAgentEnabledByAgency"
    | "webChatEnabledByAgency"
    | "inboundVoiceEnabledByAgency"
    | "whatsappEnabledByAgency"
    | "metaAgentEnabledByAgency"
    | "emailDomainEnabledByAgency"
    | "outboundVoiceEnabledByAgency"
  >,
): boolean {
  // Via aiChannelGateOn so default-on channels count for docs without the field.
  return (
    aiChannelGateOn(sub, "sms") ||
    aiChannelGateOn(sub, "web-chat") ||
    aiChannelGateOn(sub, "voice") ||
    aiChannelGateOn(sub, "whatsapp") ||
    aiChannelGateOn(sub, "meta") ||
    aiChannelGateOn(sub, "email") ||
    sub.outboundVoiceEnabledByAgency === true
  );
}

export function aiChannelLockedMessage(label: string): string {
  return `${label} is disabled for this sub-account by your agency. Ask your agency owner to enable it.`;
}
