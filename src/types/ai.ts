import type { Timestamp, FieldValue } from "firebase/firestore";

/*
 * AI agent config is split in two:
 * - `subAccounts/{id}/aiAgent/profile`: shared identity (persona, hours,
 *   escalation defaults, website KB).
 * - `subAccounts/{id}/aiAgent/{channelId}`: per-channel toggle, model and
 *   overrides.
 * The resolver merges them (channel wins when set). The old
 * `aiConfig/main` doc is migrated on first read, see agent.ts.
 */

/** Shared across every channel. A channel can't be enabled while
 *  systemPrompt is empty. */
export interface AiAgentProfile {
  systemPrompt: string;
  /** {{businessName}} in the prompt. Falls back to the sub-account name. */
  businessName: string;
  /** Auto-reply hours for all channels. start === end means 24/7. */
  hoursStart: number;
  hoursEnd: number;
  /** IANA timezone, e.g. "Australia/Sydney". */
  timezone: string;
  /** Defaults; channels can replace the list. */
  escalationKeywords: string[];
  escalationNotifyEmail: string | null;
  /** Public site the Refresh KB button scrapes into websiteKb. */
  websiteUrl: string | null;
  /** Homepage markdown, capped at ~6000 chars. Null until first refresh or
   *  after the URL is cleared. */
  websiteKb: string | null;
  websiteKbFetchedAt: Timestamp | FieldValue | null;
  /** Absent = Firecrawl. */
  websiteKbSource?: "firecrawl" | "gitpage-build" | null;
  /** Website doc whose build seeded the KB (gitpage-build only). */
  websiteKbSiteId?: string | null;
  /**
   * Published booking page the AI books on over SMS, WhatsApp and
   * Messenger/Instagram; setting it also lets the AI move and cancel those
   * contacts' bookings there. Null/absent = off (it shares the booking link).
   * Web Chat and phone have their own pickers.
   */
  messagingBookingPageSlug?: string | null;
  /**
   * Ask the booking page's intake questions before the AI books, on every
   * channel. Absent = off.
   */
  bookingAskIntake?: boolean;
  /**
   * Values the website hand-off last filled in. A field still equal to its
   * seeded value hasn't been touched by the operator, so the next published
   * site may replace it; edited fields are left alone.
   */
  websiteSeeded?: {
    systemPrompt?: string | null;
    businessName?: string | null;
    welcomeMessage?: string | null;
    accentColor?: string | null;
  } | null;
  createdAt: Timestamp | FieldValue | null;
  updatedAt: Timestamp | FieldValue | null;
}

export const DEFAULT_AI_AGENT_PROFILE: Omit<
  AiAgentProfile,
  "createdAt" | "updatedAt"
> = {
  systemPrompt: "",
  businessName: "",
  // 24/7 (start === end). Catching an after-hours lead beats a silent bot;
  // narrowing the window should be a deliberate choice.
  hoursStart: 0,
  hoursEnd: 0,
  timezone: "Australia/Sydney",
  // Keep these tight: matching is case-insensitive substring, so something
  // generic like "human" would swallow "I want to talk to a human", which the
  // [[form]] marker should handle. Escalation is for hostility / give-up.
  escalationKeywords: ["complaint", "refund", "stop ai", "speak to manager"],
  escalationNotifyEmail: null,
  websiteUrl: null,
  websiteKb: null,
  websiteKbFetchedAt: null,
};

/** `subAccounts/{id}/aiAgent/{channelId}`. */
export interface AiChannelConfig {
  enabled: boolean;
  /** Recent thread messages fed to the LLM. */
  contextMessageCount: number;
  /** OpenRouter model id. Null = AI_REPLIES_DEFAULT_MODEL. */
  modelOverride: string | null;
  /** Null = inherit from profile. [] = no keywords on this channel. */
  escalationKeywordsOverride: string[] | null;
  escalationNotifyEmailOverride: string | null;
  /** Informational running total, not enforced. */
  totalTokensUsed: number;
  /** `web-chat` doc only. Read by the widget via /api/web-chat/config. */
  webChat: WebChatChannelConfig | null;
  /** `voice` doc only. Saving it re-provisions the linked Vapi resources. */
  voice: VoiceChannelConfig | null;
  /** `whatsapp` doc only. Creds and sender number live on `twilioConfig`. */
  whatsapp: WhatsappChannelConfig | null;
  createdAt: Timestamp | FieldValue | null;
  updatedAt: Timestamp | FieldValue | null;
}

export type VoiceNumberMode = "twilio-byoc" | "vapi-managed";

/** `aiAgent/voice`.voice. Clearing the Vapi ids forces a re-provision on the
 *  next save. */
export interface VoiceChannelConfig {
  /** First line on an inbound call; kept apart from the persona. */
  greeting: string;
  /** Vapi voice provider id, e.g. "11labs" or "openai". */
  voiceProvider: string;
  /** e.g. an ElevenLabs voice id or OpenAI voice name ("alloy"). */
  voiceId: string;
  /**
   * Sent as the Vapi voice `version` when set; null sends nothing. Stored
   * because leaving it out put named voices on the provider's oldest model.
   */
  voiceVersion?: string | null;
  /**
   * Null sends no transcriber block (Vapi default). Stored explicitly since an
   * omitted block only survives PATCH by accident and resets on the 404
   * re-create path.
   */
  transcriberProvider?: string | null;
  transcriberModel?: string | null;
  /** Seconds. Enforced by Vapi. */
  maxCallSeconds: number;
  /**
   * Published booking page the inbound agent can book on. Null = off (agent
   * shares the booking link instead). Deposit pages are refused at runtime.
   */
  bookingPageSlug?: string | null;
  /**
   * Lets a caller recognised by caller ID move or cancel their upcoming
   * bookings. Off unless set: caller ID can be spoofed.
   */
  allowCallerChanges?: boolean;
  /**
   * "twilio-byoc" (default): the sub-account's dedicated Twilio number, one
   * number for SMS + voice. "vapi-managed": a number the operator owns in
   * Vapi (handy for testing without AU regulatory bundles).
   */
  numberMode: VoiceNumberMode;
  /** Server-managed; null until the first successful save. */
  vapiAssistantId: string | null;
  /**
   * byoc: server-managed, created at provisioning and cleared on disable.
   * vapi-managed: pasted by the operator; we only bind our assistant to it.
   */
  vapiPhoneNumberId: string | null;

  // Outbound shares the inbound assistant + number. Limits are enforced in
  // lib/comms/voice/outbound-compliance.ts before any call is placed.

  /** Independent of inbound `enabled`. Also needs
   *  `outboundVoiceEnabledByAgency`. */
  outboundEnabled: boolean;
  /** Sent per call via assistantOverrides.firstMessage. */
  outboundFirstMessage: string;
  /** Outbound-only persona; blank = shared profile persona. The LLM webhook
   *  swaps it in when call metadata marks the call outbound. */
  outboundSystemPrompt: string;
  /** Evaluated in the contact's timezone (from their phone country). Null =
   *  profile timezone with default hours. */
  outboundWindow: { startHour: number; endHour: number; timezone: string } | null;
  /** In-memory token bucket. */
  outboundPerMinuteCap: number;
  /** Firestore count. */
  outboundDailyCap: number;
  /** Anti-harassment cap per number. */
  outboundPerNumberPerDay: number;
  /** ISO 3166-1 alpha-2 allow-list. Null = all countries. */
  allowedCountries: string[] | null;
}

/** `aiAgent/web-chat`.webChat. */
export interface WebChatChannelConfig {
  /**
   * Bare hostnames, compared case-insensitively to the Origin header, e.g.
   * ["example.com", "www.example.com"]. Empty = unrestricted; test only.
   */
  allowedDomains: string[];
  welcomeMessage: string;
  /** Hex, used for the bubble and send button. */
  accentColor: string;
  position: "right" | "left";
  /**
   * Published booking page the assistant can book on, typed or spoken. Null
   * or absent = off (the assistant shares the booking link instead). Deposit
   * pages are refused at runtime.
   */
  bookingPageSlug?: string | null;
}

/** `aiAgent/whatsapp`.whatsapp. */
export interface WhatsappChannelConfig {
  /**
   * Free-form sends are only allowed this long after the contact's last
   * inbound; outside it a template is required. Meta's window is 24h.
   */
  sessionWindowHours: number;
}

export const DEFAULT_AI_CHANNEL_CONFIG: Omit<
  AiChannelConfig,
  "createdAt" | "updatedAt"
> = {
  enabled: false,
  contextMessageCount: 10,
  modelOverride: null,
  escalationKeywordsOverride: null,
  escalationNotifyEmailOverride: null,
  totalTokensUsed: 0,
  webChat: null,
  voice: null,
  whatsapp: null,
};

export const DEFAULT_WHATSAPP_CONFIG: WhatsappChannelConfig = {
  sessionWindowHours: 24,
};

export const DEFAULT_WEB_CHAT_CONFIG: WebChatChannelConfig = {
  allowedDomains: [],
  welcomeMessage: "Hi! How can I help?",
  accentColor: "#7c3aed",
  position: "right",
};

export const DEFAULT_VOICE_CONFIG: VoiceChannelConfig = {
  greeting: "Hi, thanks for calling. How can I help?",
  // OpenAI voice names resolve in Vapi with no provider key. The Vapi preset
  // "11labs"/"burt" no longer exists and assistant creation 400s on it.
  // ElevenLabs still works via a custom voice ID in the Voice settings.
  voiceProvider: "openai",
  voiceId: "alloy",
  maxCallSeconds: 600,
  bookingPageSlug: null,
  numberMode: "twilio-byoc",
  vapiAssistantId: null,
  vapiPhoneNumberId: null,
  outboundEnabled: false,
  outboundFirstMessage:
    "Hi, this is the team following up on your enquiry — is now a good time for a quick chat?",
  outboundSystemPrompt: "",
  outboundWindow: { startHour: 9, endHour: 18, timezone: "Australia/Sydney" },
  outboundPerMinuteCap: 10,
  outboundDailyCap: 200,
  outboundPerNumberPerDay: 1,
  allowedCountries: null,
};

/** Profile + channel merged, ready for the LLM call. */
export interface ResolvedAiAgent {
  profile: AiAgentProfile;
  channel: AiChannelConfig;
  /** After channel overrides. */
  effective: {
    enabled: boolean;
    systemPrompt: string;
    businessName: string;
    hoursStart: number;
    hoursEnd: number;
    timezone: string;
    escalationKeywords: string[];
    escalationNotifyEmail: string | null;
    contextMessageCount: number;
    modelOverride: string | null;
    websiteKb: string | null;
  };
}

/** Logged to the activity timeline so a quiet bot can be debugged. */
export type AiSkipReason =
  | "disabled"
  | "no_prompt"
  | "outside_hours"
  | "escalation_keyword"
  | "contact_opted_out"
  | "no_contact_match"
  | "llm_failed";
