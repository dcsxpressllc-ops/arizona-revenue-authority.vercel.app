import type { UsageQuotas, UsageRates } from "@/types/usage";
import type { UsageMonthRow } from "@/types/usage-billing";

/** Display metadata for the billable units. Client-safe. */
export interface UsageUnitMeta {
  /** Counter shown as "used". */
  field: keyof Omit<UsageMonthRow, "month" | "aiCostBySource">;
  /** Counter that's billed (SMS bills only the shared slice). */
  billableField: keyof Omit<UsageMonthRow, "month" | "aiCostBySource">;
  quotaKey: keyof UsageQuotas;
  /** null = can't carry a rate (cap only). */
  rateKey: keyof UsageRates | null;
  label: string;
  /** "per email", shown next to the rate. */
  per: string;
  /** Ledger counts seconds; quotas and display are minutes. */
  minutes: boolean;
  /** Why there is no rate input, when rateKey is null. */
  capOnlyReason?: string;
}

export const USAGE_UNIT_META: UsageUnitMeta[] = [
  {
    field: "emailsSent",
    billableField: "emailsSent",
    quotaKey: "emailsPerMonth",
    rateKey: "emailCents",
    label: "Emails",
    per: "per email",
    minutes: false,
  },
  {
    field: "smsSegments",
    billableField: "smsSegmentsShared",
    quotaKey: "smsSegmentsPerMonth",
    rateKey: "smsSegmentCents",
    label: "SMS segments",
    per: "per segment (shared number only)",
    minutes: false,
  },
  {
    field: "aiReplies",
    billableField: "aiReplies",
    quotaKey: "aiRepliesPerMonth",
    rateKey: "aiReplyCents",
    label: "AI replies",
    per: "per reply",
    minutes: false,
  },
  {
    field: "voiceSeconds",
    billableField: "voiceSeconds",
    quotaKey: "voiceMinutesPerMonth",
    rateKey: "voiceMinuteCents",
    label: "Phone voice minutes",
    per: "per minute (carrier minutes stay on the client's Twilio)",
    minutes: true,
  },
  {
    field: "webVoiceSeconds",
    billableField: "webVoiceSeconds",
    quotaKey: "webVoiceMinutesPerMonth",
    rateKey: "webVoiceMinuteCents",
    label: "Web voice minutes",
    per: "per minute (audio stays on the client's ElevenLabs)",
    minutes: true,
  },
  {
    field: "whatsappMessages",
    billableField: "whatsappMessages",
    quotaKey: "whatsappPerMonth",
    rateKey: null,
    label: "WhatsApp messages",
    per: "",
    minutes: false,
    capOnlyReason: "Runs on the client's own Twilio, so it can't be metered.",
  },
  {
    field: "aiTokens",
    billableField: "aiTokens",
    quotaKey: "aiTokensPerMonth",
    rateKey: null,
    label: "AI tokens",
    per: "",
    minutes: false,
    capOnlyReason: "A safety cap only; AI is billed per reply.",
  },
];

/** Ledger value for display (seconds become whole minutes). */
export function displayUnits(meta: UsageUnitMeta, n: number): string {
  return meta.minutes ? Math.round(n / 60).toLocaleString() : n.toLocaleString();
}

/** Typed dollars to integer cents; blank or invalid = undefined. */
export function dollarsToCents(raw: string): number | undefined {
  const n = Number.parseFloat(raw.trim());
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : undefined;
}

/** Cents to an input value ("0.02", "50"). */
export function centsToDollars(cents: number | null | undefined): string {
  return cents != null && cents > 0 ? (cents / 100).toFixed(2).replace(/\.00$/, "") : "";
}
