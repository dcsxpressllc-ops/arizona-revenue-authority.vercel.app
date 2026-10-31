/**
 * Voice in the web-chat widget on the sub-account's own ElevenLabs key.
 * ElevenLabs handles STT/TTS and turn-taking; replies come from our web-chat
 * pipeline as a custom LLM, so persona and KB match typed chat.
 *
 * The key and usage live under private/ (server only). subAccountDoc.webVoiceMeta
 * is readable by every member, so never put credentials there.
 */

export const WEB_VOICE_CONNECTION_DOC_ID = "webVoiceConnection";
export const WEB_VOICE_USAGE_DOC_ID = "webVoiceUsage";

export function webVoiceConnectionPath(subAccountId: string): string {
  return `subAccounts/${subAccountId}/private/${WEB_VOICE_CONNECTION_DOC_ID}`;
}

export function webVoiceUsagePath(subAccountId: string): string {
  return `subAccounts/${subAccountId}/private/${WEB_VOICE_USAGE_DOC_ID}`;
}

/** Shared by the secret and display docs. */
export interface WebVoiceSettings {
  /** Off hides the mic but keeps the connection. */
  enabled: boolean;
  voiceId: string;
  voiceName: string;
  /** ISO-639-1. */
  language: string;
  greeting: string;
  /** Per-conversation cap, enforced by ElevenLabs. */
  maxCallSeconds: number;
  /** Per UTC day. Mic is hidden once reached. */
  dailyMinuteCap: number;
}

export const WEB_VOICE_DEFAULTS: Omit<WebVoiceSettings, "voiceId" | "voiceName"> = {
  enabled: true,
  language: "en",
  greeting: "Hi there! I'm listening — how can I help you today?",
  maxCallSeconds: 300,
  dailyMinuteCap: 60,
};

export const WEB_VOICE_LIMITS = {
  maxCallSecondsMin: 60,
  maxCallSecondsMax: 1800,
  dailyMinuteCapMin: 5,
  dailyMinuteCapMax: 1440,
  greetingMaxChars: 300,
  /** Simultaneous voice conversations per sub-account. */
  concurrency: 3,
} as const;

/** Picker subset; ElevenLabs supports more. */
export const WEB_VOICE_LANGUAGES: { code: string; label: string }[] = [
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "it", label: "Italian" },
  { code: "pt", label: "Portuguese" },
  { code: "nl", label: "Dutch" },
  { code: "pl", label: "Polish" },
  { code: "sv", label: "Swedish" },
  { code: "hi", label: "Hindi" },
  { code: "ja", label: "Japanese" },
  { code: "zh", label: "Chinese" },
  { code: "ko", label: "Korean" },
  { code: "ar", label: "Arabic" },
];

/** Server only. */
export interface WebVoiceConnectionSecret extends WebVoiceSettings {
  apiKey: string;
  /** Agent on the client's ElevenLabs account. Null until provisioned. */
  agentId: string | null;
  /** Random segment in the custom-LLM URL so only this agent can call our reply endpoint. */
  endpointSecret: string;
}

/** On the member-readable sub-account doc. Never add the key here. */
export interface WebVoiceMeta extends WebVoiceSettings {
  /** Agent exists and settings are synced. */
  ready: boolean;
  keyLast4: string;
  lastError: string | null;
  connectedAt: Date | null;
}

/** Keyed by ElevenLabs conversation id. */
export interface WebVoicePending {
  sessionId: string;
  startedAtMs: number;
}

/** Server only. */
export interface WebVoiceUsageDoc {
  /** UTC YYYY-MM-DD. */
  day: string;
  secondsToday: number;
  /** YYYY-MM. */
  month: string;
  secondsThisMonth: number;
  /** Started but not settled yet, so duration is unknown. */
  pending: Record<string, WebVoicePending>;
  /** Unclaimed signed-URL grants (grant id -> issued ms). Count toward concurrency so a burst can't bypass the cap. */
  grants: Record<string, number>;
  /** Bounded list of counted ids so /end can't double count. */
  settled: string[];
}

export interface WebVoicePublicConfig {
  voiceEnabled: boolean;
  /** Short-lived; required by /api/web-chat/voice/start. */
  voiceToken?: string;
}
