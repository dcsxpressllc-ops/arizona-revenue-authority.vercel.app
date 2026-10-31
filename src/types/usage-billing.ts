import type { FeeGateKey } from "./billing";
import type {
  AiCostSource,
  FeatureFees,
  UsageQuotas,
  UsageRates,
  UsageUnit,
} from "./usage";

/** One month of the ledger as the agency usage API returns it. */
export interface UsageMonthRow {
  month: string;
  emailsSent: number;
  smsSegments: number;
  smsSegmentsShared: number;
  whatsappMessages: number;
  aiTokens: number;
  aiReplies: number;
  voiceSeconds: number;
  webVoiceSeconds: number;
  softphoneSeconds: number;
  firecrawlScrapes: number;
  /** Actual OpenRouter cost, millionths of a dollar. Agency eyes only. */
  aiCostMicros: number;
  aiCostBySource: Partial<Record<AiCostSource, number>>;
}

export interface FeeLineWire {
  gateKey: FeeGateKey;
  label: string;
  cents: number;
}

/** GET /api/sub-accounts/[id]/usage: the client's own view, priced units only. */
export interface ClientUsageResponse {
  /** Whether the Billing tab has a usage section to show. */
  show: boolean;
  rebilled: boolean;
  month: string;
  currency: string;
  units: {
    label: string;
    minutes: boolean;
    /** Billable usage so far (ledger units; seconds for minutes). */
    used: number;
    included: number;
    billableUnits: number;
    cents: number;
    rateCents: number;
  }[];
  fees: { label: string; cents: number }[];
  carriedInCents: number;
  estimatedCents: number;
  spendCap: { cents: number; usedCents: number } | null;
  charges: {
    id: string;
    month: string | null;
    amountCents: number;
    currency: string;
    status: "pending" | "paid";
    dueAt: string | null;
    paidAt: string | null;
    lineItems: { label: string; amountCents: number; detail?: string }[];
  }[];
}

/** GET /api/agency/sub-accounts/[id]/usage. */
export interface AgencyUsageResponse {
  usage: UsageMonthRow[];
  quotas: UsageQuotas | null;
  rates: UsageRates | null;
  currency: string;
  quotaSource: "workspace" | "plan" | "none";
  overage: {
    perUnit: Partial<Record<UsageUnit, { overUnits: number; cents: number }>>;
    totalCents: number;
  };
  fees: { lines: FeeLineWire[]; totalCents: number };
  carriedInCents: number;
  /** This month so far: overage + fees + carried. 0 unless rebilled. */
  estimatedCents: number;
  spendCapCents: number | null;
  rebilling: { active: boolean; agency: boolean; client: boolean };
  lastClosed: {
    month: string;
    skipped: boolean;
    totalCents: number;
    carryOutCents: number;
    chargeId: string | null;
  } | null;
  config: {
    overrides: {
      usageQuotas: UsageQuotas | null;
      usageRates: UsageRates | null;
      usageSpendCapCents: number | null;
      featureFees: FeatureFees | null;
    };
    plan: {
      name: string;
      quotas: UsageQuotas | null;
      rates: UsageRates | null;
      spendCapCents: number | null;
      featureFees: FeatureFees | null;
    } | null;
    /** Runs SMS on its own Twilio, so SMS can't carry a rate here. */
    dedicatedSms: boolean;
  };
}
