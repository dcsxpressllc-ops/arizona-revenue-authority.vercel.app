import type { Timestamp, FieldValue } from "firebase/firestore";

/**
 * Affiliate program. Every touchpoint is gated on
 * LANDING_VARIANT === "leadstack"; on "custom" deployments it all no-ops or
 * 404s. Last-click attribution with a 30-day cookie, self-referrals (buyer
 * email equals affiliate email) get no credit, buyers are auto-enrolled at
 * purchase.
 */

export type AffiliateStatus = "active" | "paused" | "banned";

export type AffiliatePayoutMethod = "paypal" | "bank" | "other";

export interface Affiliate {
  id: string;
  email: string;
  code: string;
  /** From Stripe `customer_details.name` when available. */
  displayName: string | null;
  status: AffiliateStatus;
  /** Whole-number percent, e.g. 40. */
  commissionPct: number;
  /** Lifetime totals, updated atomically on referral status changes. */
  referralCount: number;
  pendingCommissionCents: number;
  paidCommissionCents: number;
  /**
   * Entered by the affiliate. Missing = null. `payoutDetails` is free text
   * (PayPal email, or bank details).
   */
  payoutMethod?: AffiliatePayoutMethod | null;
  payoutDetails?: string | null;
  payoutDetailsUpdatedAt?: Timestamp | FieldValue | null;
  createdAt: Timestamp | FieldValue | null;
  updatedAt: Timestamp | FieldValue | null;
}

export type ReferralStatus = "pending" | "paid" | "voided";

/**
 * Missing = "source". source: one row per purchase, keyed by checkout
 * session id. cloud: one row per paid invoice (first and renewals), keyed by
 * invoice id.
 */
export type ReferralProduct = "source" | "cloud";
export type ReferralKind = "purchase" | "first" | "renewal";

/**
 * One doc per visitor per day per code (deterministic id), so repeat and bot
 * hits don't multiply writes.
 */
export interface Click {
  id: string;
  affiliateCode: string;
  /** SHA-256 of the visitor IP, salted with AUTOMATIONS_TOKEN_SECRET. */
  ipHash: string;
  userAgent: string;
  landingPath: string;
  referrer: string | null;
  /** YYYYMMDD, for cheap aggregation. */
  dayKey: string;
  createdAt: Timestamp | FieldValue | null;
}

export interface Referral {
  id: string;
  affiliateId: string;
  /** Code at attribution time (denormalized). */
  affiliateCode: string;
  purchaseSessionId: string;
  buyerEmail: string;
  amountPaidCents: number;
  /** Computed at credit time. */
  commissionCents: number;
  status: ReferralStatus;
  /** Set by the agency owner when the payout is sent. */
  paidOutAt: Timestamp | FieldValue | null;
  /** e.g. "PayPal txn ABC123". */
  paidOutNote: string | null;
  createdAt: Timestamp | FieldValue | null;

  // Optional; older rows don't have these.
  product?: ReferralProduct;
  kind?: ReferralKind;
  /** Basis points (4000 = 40%). Missing = 40%. */
  rateBps?: number;
  /** createdAt + maturity window. */
  eligibleAt?: Timestamp | FieldValue | null;
  subscriptionId?: string | null;
  invoiceId?: string | null;
  cloudId?: string | null;
  periodStart?: Timestamp | FieldValue | null;
  periodEnd?: Timestamp | FieldValue | null;
  /** Set on refund or dispute. */
  voidedAt?: Timestamp | FieldValue | null;
  voidReason?: string | null;
  /** Full refund after payout; needs a manual clawback. */
  refundedAfterPayout?: boolean;
  /** Partial refunds are flagged for review, not auto-voided. */
  partialRefundCents?: number | null;
}
