import type { FieldValue, Timestamp } from "firebase/firestore";
import type { FeeGateKey } from "./billing";

/**
 * One increment-only ledger doc per workspace per month at subAccounts/{id}/usage/{YYYY-MM}.
 * Server-only (rules deny); reads go through the owner-only agency API. Missing doc = zero usage.
 */

/** Also the field names on the month doc. */
export type UsageUnit =
  | "emailsSent"
  | "smsSegments"
  | "whatsappMessages"
  | "aiTokens"
  | "aiReplies"
  | "voiceSeconds"
  | "webVoiceSeconds";

export const USAGE_UNITS: UsageUnit[] = [
  "emailsSent",
  "smsSegments",
  "whatsappMessages",
  "aiTokens",
  "aiReplies",
  "voiceSeconds",
  "webVoiceSeconds",
];

/**
 * Monthly included allowance; voice in minutes. A hard cap unless the client is
 * rebilled and the unit has a rate, where it's the free units before overage.
 */
export interface UsageQuotas {
  emailsPerMonth?: number | null;
  smsSegmentsPerMonth?: number | null;
  whatsappPerMonth?: number | null;
  aiTokensPerMonth?: number | null;
  aiRepliesPerMonth?: number | null;
  voiceMinutesPerMonth?: number | null;
  webVoiceMinutesPerMonth?: number | null;
}

/** Sell prices in cents, typed by the owner, never derived from provider costs. */
export interface UsageRates {
  emailCents?: number | null;
  /** Shared-sender segments only; a client's own Twilio is never billed. */
  smsSegmentCents?: number | null;
  /** For a future agency-hosted sender; refused while WhatsApp runs on the client's Twilio. */
  whatsappMessageCents?: number | null;
  aiReplyCents?: number | null;
  /** The agency's side of a call (Vapi + AI); the carrier leg is on the client's Twilio. */
  voiceMinuteCents?: number | null;
  webVoiceMinuteCents?: number | null;
  /** @deprecated Ignored; AI is priced per reply. */
  aiTokensPer1kCents?: number | null;
}

/** A flat monthly fee for a feature gate, billed in arrears. */
export interface FeatureFee {
  /** Shown to the client on the invoice. */
  label: string;
  cents: number;
}

export type FeatureFees = Partial<Record<FeeGateKey, FeatureFee>>;

/** Every ledger counter. `smsSegmentsShared` is the agency-paid slice of `smsSegments`. */
export type UsageCounter =
  | UsageUnit
  | "smsSegmentsShared"
  | "aiReplies"
  | "webVoiceSeconds"
  | "softphoneSeconds"
  | "firecrawlScrapes";

/** Where an OpenRouter call's cost came from, for the agency's breakdown. */
export type AiCostSource =
  | "replies"
  | "voice"
  | "webVoice"
  | "assistant"
  | "workflows"
  | "watchdog"
  | "other";

export const AI_COST_SOURCES: AiCostSource[] = [
  "replies",
  "voice",
  "webVoice",
  "assistant",
  "workflows",
  "watchdog",
  "other",
];

/** Required on every OpenRouter call; agency-only work never lands on a client ledger. */
export type AiMeter =
  | { subAccountId: string; source: AiCostSource }
  | { agencyInternal: true };

/** Counters only ever move via FieldValue.increment. */
export interface UsageMonthDoc {
  emailsSent?: number;
  smsSegments?: number;
  /** Agency-paid (shared sender) part of smsSegments. */
  smsSegmentsShared?: number;
  whatsappMessages?: number;
  aiTokens?: number;
  /** Customer-facing text completions; voice turns are priced by the minute instead. */
  aiReplies?: number;
  voiceSeconds?: number;
  webVoiceSeconds?: number;
  /** Visibility only: runs on the client's own Twilio. */
  softphoneSeconds?: number;
  firecrawlScrapes?: number;
  /** Actual OpenRouter cost in millionths of a dollar. Agency eyes only. */
  aiCostMicros?: number;
  aiCostBySource?: Partial<Record<AiCostSource, number>>;
  /** Gates that were on at some point this month; flat fees bill from this. */
  featuresOn?: Partial<Record<FeeGateKey, boolean>>;
  /** Stamped once per month per unit at 80% and 100%. */
  warnedAt?: Partial<Record<UsageUnit, Timestamp | FieldValue>>;
  cappedAt?: Partial<Record<UsageUnit, Timestamp | FieldValue>>;
  /** Client "now billed" email stamps, separate from the owner cap stamps. */
  clientCappedAt?: Partial<Record<UsageUnit, Timestamp | FieldValue>>;
  /** Spend-ceiling alert stamps, keyed "80" / "100". */
  ceiling?: Partial<Record<"80" | "100", Timestamp | FieldValue>>;
  updatedAt?: Timestamp | FieldValue;
}
