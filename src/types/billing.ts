import type { Timestamp, FieldValue } from "firebase/firestore";

/**
 * Agency -> sub-account plans + paywall, charged through the deployment's own
 * Stripe account (one agency per deployment, no Connect). Payment state lives
 * on `SubAccountDoc.billing`; plans at `agencies/{agencyId}/plans`.
 * Money is integer cents.
 */

/**
 * Gates a plan can bundle: the Manage-dialog set minus Get Leads (parked).
 * Activating a plan writes exactly these fields, so the plan owns a managed
 * client's gates. `*HiddenWhenDisabled` overrides stay manual.
 */
export const PLAN_GATE_KEYS = [
  "emailDomainEnabledByAgency",
  "apiAccessEnabledByAgency",
  "broadcastsEnabledByAgency",
  "outboundVoiceEnabledByAgency",
  "whatsappEnabledByAgency",
  "smsAgentEnabledByAgency",
  "webChatEnabledByAgency",
  "inboundVoiceEnabledByAgency",
  "metaInboxEnabledByAgency",
  "metaAgentEnabledByAgency",
  "websiteEnabledByAgency",
  "socialPlannerEnabledByAgency",
  "communityEnabledByAgency",
  "missedCallTextBackEnabledByAgency",
  "aiSuiteEnabledByAgency",
  "labsEnabledByAgency",
] as const;

export type PlanGateKey = (typeof PLAN_GATE_KEYS)[number];

export const PLAN_GATE_LABELS: Record<PlanGateKey, string> = {
  emailDomainEnabledByAgency: "Dedicated email sending domain",
  apiAccessEnabledByAgency: "Public API access",
  broadcastsEnabledByAgency: "Email broadcasts",
  outboundVoiceEnabledByAgency: "Outbound AI voice calls",
  whatsappEnabledByAgency: "WhatsApp channel",
  smsAgentEnabledByAgency: "SMS AI auto-reply",
  webChatEnabledByAgency: "Web Chat AI",
  inboundVoiceEnabledByAgency: "Inbound Voice AI",
  metaInboxEnabledByAgency: "Facebook + Instagram inbox",
  metaAgentEnabledByAgency: "Messenger & Instagram AI auto-reply",
  websiteEnabledByAgency: "Website builder",
  socialPlannerEnabledByAgency: "Social Planner",
  communityEnabledByAgency: "Community + Courses",
  missedCallTextBackEnabledByAgency: "Missed Call Text Back",
  aiSuiteEnabledByAgency: "AI Suite assistant",
  labsEnabledByAgency: "Labs (pre-release features)",
};

/** Every key present; true = enabled. */
export type PlanGates = Record<PlanGateKey, boolean>;

/**
 * Gates a flat monthly fee can hang off: everything a plan bundles plus the
 * standalone gates. Get Leads is parked, so it can't carry a fee.
 */
export const FEE_GATE_KEYS = [
  ...PLAN_GATE_KEYS,
  "paymentsEnabledByAgency",
  "webinar1EnabledByAgency",
  "webVoiceEnabledByAgency",
  "sellOnlineEnabledByAgency",
  "aiOutboundSmsEnabledByAgency",
] as const;

export type FeeGateKey = (typeof FEE_GATE_KEYS)[number];

export const FEE_GATE_LABELS: Record<FeeGateKey, string> = {
  ...PLAN_GATE_LABELS,
  paymentsEnabledByAgency: "Payments",
  webinar1EnabledByAgency: "Webinars",
  webVoiceEnabledByAgency: "Web Voice",
  sellOnlineEnabledByAgency: "Sell online",
  aiOutboundSmsEnabledByAgency: "AI texts",
};

/** AI channel gates that predate gating read as on unless explicitly false. */
export const OPT_OUT_GATE_KEYS: ReadonlySet<FeeGateKey> = new Set<FeeGateKey>([
  "smsAgentEnabledByAgency",
  "webChatEnabledByAgency",
  "inboundVoiceEnabledByAgency",
]);

/** Whether a gate is on for a sub-account doc, honouring the opt-out defaults. */
export function feeGateOn(
  sub: Partial<Record<FeeGateKey, unknown>>,
  key: FeeGateKey,
): boolean {
  return OPT_OUT_GATE_KEYS.has(key) ? sub[key] !== false : sub[key] === true;
}

/**
 * Picked at assignment time, not on the plan (a plan may offer both).
 * Maps 1:1 to Stripe's `recurring.interval`.
 */
export type BillingInterval = "month" | "year";

export type BillingPlanStatus = "active" | "archived";

/**
 * `agencies/{agencyId}/plans/{planId}`, server-only writes via /api/agency/plans.
 * Creating a plan creates a Stripe Product + monthly Price on the deployment's
 * account. Stripe prices are immutable, so a price edit mints a new Price and
 * deactivates the old one; existing subscriptions keep their signup price.
 */
export interface BillingPlanDoc {
  id: string;
  agencyId: string;
  /** 1-60 chars. */
  name: string;
  /** Up to 300 chars. */
  description: string | null;
  /** Stripe minimum (~50c) enforced at create. */
  priceMonthlyCents: number;
  /**
   * null = monthly-only. Typed directly by the agency (no auto discount) and
   * minted as a second interval=year Price on the same Product.
   */
  priceAnnualCents: number | null;
  /** Lowercase ISO 4217. Fixed after creation. */
  currency: string;
  gates: PlanGates;
  /**
   * Per-month usage quotas; null/absent = unlimited. Read live (cached), so
   * edits apply to subscribers without a re-apply. Overridable per workspace
   * via `SubAccountDoc.usageQuotas`.
   */
  quotas?: import("./usage").UsageQuotas | null;
  /** Sell rates (cents) beyond `quotas`; billed monthly in arrears for rebilled clients. */
  rates?: import("./usage").UsageRates | null;
  /** Monthly overage ceiling in cents; priced channels pause there. null = none. */
  spendCapCents?: number | null;
  /** Flat monthly fees keyed by gate. */
  featureFees?: import("./usage").FeatureFees | null;
  status: BillingPlanStatus;
  stripeProductId: string | null;
  stripePriceId: string | null;
  /** null when monthly-only. */
  stripeAnnualPriceId: string | null;
  createdAt: Timestamp | FieldValue | Date | null;
  updatedAt: Timestamp | FieldValue | Date | null;
}

/** /api/agency/plans wire shape (ISO timestamps). */
export interface BillingPlanResponse {
  id: string;
  name: string;
  description: string | null;
  priceMonthlyCents: number;
  priceAnnualCents: number | null;
  currency: string;
  gates: PlanGates;
  quotas?: import("./usage").UsageQuotas | null;
  rates?: import("./usage").UsageRates | null;
  spendCapCents?: number | null;
  featureFees?: import("./usage").FeatureFees | null;
  status: BillingPlanStatus;
  createdAt: string | null;
  updatedAt: string | null;
}

/**
 * comped: not billed here (default; docs with no `billing` field). Gates manual.
 * pending: plan assigned, unpaid; members see the activation paywall.
 * past_due: renewal failed; dunning banner until `graceUntil`, then paywall.
 * canceled: hard paywall, data kept; re-checkout reactivates.
 */
export type SubAccountBillingStatus =
  | "comped"
  | "pending"
  | "active"
  | "past_due"
  | "canceled";

/**
 * `SubAccountDoc.billing`. Server-only writes; member-readable with the rest
 * of the doc so the paywall renders without extra reads.
 */
export interface SubAccountBilling {
  status: SubAccountBillingStatus;
  planId: string | null;
  /** Denormalized; refreshed on assign/activate. */
  planName: string | null;
  /**
   * Effective charge per `billingInterval` (special price wins). Yearly amount
   * for annual subscriptions; divide by 12 for MRR.
   */
  priceCents: number | null;
  /** null for comped/legacy docs, treated as monthly. */
  billingInterval: BillingInterval | null;
  currency: string | null;
  /** null = plan's standard price. */
  specialPriceCents: number | null;
  /** Price used by checkout, stamped at assignment so /pay doesn't re-resolve the plan. */
  stripePriceId: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  /**
   * SHA-256 of the live checkout-link token; the raw token only exists in the
   * URL. Rotated on every send/copy, null once consumed.
   */
  checkoutTokenHash: string | null;
  /**
   * Stamped when the subscription first goes past_due, cleared on recovery.
   * Checked at render time (no cron): past_due + elapsed = hard paywall.
   */
  graceUntil: Timestamp | FieldValue | Date | null;
  assignedAt: Timestamp | FieldValue | Date | null;
  activatedAt: Timestamp | FieldValue | Date | null;
  updatedAt: Timestamp | FieldValue | Date | null;
}

/** Days after a failed renewal before the hard paywall. */
export const BILLING_GRACE_DAYS = 7;

// One-time charges (agency charging its client once, e.g. a web design fee)

/** pending: /pay/charge link live. paid: webhook-confirmed. canceled: link dead. */
export type BillingChargeStatus = "pending" | "paid" | "canceled";

/**
 * `billingCharges/{id}`, server-only writes, read via the owner-only API.
 * Not to be confused with the sub-account's own quotes/invoices to its customers.
 * Paid through `mode: "payment"` Checkout with ad-hoc price_data (no Product).
 */
export interface BillingChargeDoc {
  id: string;
  agencyId: string;
  subAccountId: string;
  /** Shown on the Stripe checkout line, 1-120 chars. */
  description: string;
  amountCents: number;
  /** Lowercase ISO 4217. */
  currency: string;
  status: BillingChargeStatus;
  /** SHA-256 of the live /pay/charge token. Rotated on re-send; null once paid or canceled. */
  tokenHash: string | null;
  stripeCheckoutSessionId: string | null;
  stripePaymentIntentId: string | null;
  createdByUid: string;
  createdAt: Timestamp | FieldValue | Date | null;
  paidAt: Timestamp | FieldValue | Date | null;
  updatedAt: Timestamp | FieldValue | Date | null;
  /** Absent = manual. Usage charges are minted by the month-close cron. */
  kind?: BillingChargeKind;
  /** "YYYY-MM" the usage charge covers. */
  usageMonth?: string;
  /** Itemized breakdown shown in the email and the client's Billing tab. */
  lineItems?: UsageChargeLine[];
  dueAt?: Timestamp | FieldValue | Date | null;
  /** Pay link kept for reminders so they don't rotate the link in the first email. */
  payUrl?: string | null;
  /** Reminder stamps, one each per charge. */
  remindedAt?: {
    beforeDue?: Timestamp | FieldValue | null;
    onDue?: Timestamp | FieldValue | null;
    overdue?: Timestamp | FieldValue | null;
  };
  /** Where the invoice email went, or null when there was no recipient. */
  emailedTo?: string | null;
  /** Set while the invoice email is being sent, so overlapping runs send it once. */
  invoiceEmailClaimedAt?: Timestamp | FieldValue | null;
}

export type BillingChargeKind = "manual" | "usage";

export interface UsageChargeLine {
  label: string;
  amountCents: number;
  /** e.g. "240 billable" or "12.5 billable min". */
  detail?: string;
}

/** Charges API wire shape (ISO timestamps). */
export interface BillingChargeResponse {
  id: string;
  subAccountId: string;
  description: string;
  amountCents: number;
  currency: string;
  status: BillingChargeStatus;
  createdAt: string | null;
  paidAt: string | null;
  kind: BillingChargeKind;
  usageMonth: string | null;
  lineItems: UsageChargeLine[];
  dueAt: string | null;
}
