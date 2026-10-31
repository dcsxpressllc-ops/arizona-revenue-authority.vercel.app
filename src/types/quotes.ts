import type { Timestamp, FieldValue } from "firebase/firestore";

/**
 * Quotes (estimates) and invoices.
 *
 * draft -> sent -> viewed -> accepted | declined | expired, accepted -> paid
 * (marked manually). "expired" is derived at read time from `validUntil`, so
 * no sweep is needed. Only the SHA-256 of the public token is stored, so a DB
 * dump can't leak shareable links.
 */

export type QuoteStatus =
  | "draft"
  | "sent"
  | "viewed"
  | "accepted"
  | "declined"
  | "expired"
  | "paid";

/**
 * `invoice` is a demand for payment. An accepted quote can be converted in
 * place via /convert-to-invoice (kind flips, new invoice number).
 */
export type QuoteKind = "quote" | "invoice";

export interface QuoteLineItem {
  /** Client-generated; items live inline on the quote, not as docs. */
  id: string;
  description: string;
  /** Fractional allowed (2.5 hours). Clamped >= 0. */
  quantity: number;
  /** Whole currency units, not cents. Clamped >= 0. */
  unitPrice: number;
  /**
   * Source catalog product, null for ad-hoc lines. The description/price
   * snapshot is authoritative; later product edits never touch this line.
   */
  productId?: string | null;
}

/** Applied to the line-item subtotal. */
export type QuoteDiscount =
  | { type: "percent"; value: number } // 0-100
  | { type: "flat"; value: number } // whole units of the quote currency
  | null;

/** Fixed picker on the public page. "Other" requires a note. */
export const DECLINE_REASONS = [
  "Too expensive",
  "Not the right fit",
  "Bad timing",
  "Going with a competitor",
  "Other",
] as const;
export type DeclineReason = (typeof DECLINE_REASONS)[number];

export interface Quote {
  id: string;

  agencyId: string;
  subAccountId: string;
  createdByUid: string;

  contactId: string;
  /**
   * `Q-YYYY-NNNN` or `INV-YYYY-NNNN`, issued transactionally by
   * lib/quotes/number.ts. Quotes and invoices use separate per-sub-account counters.
   */
  quoteNumber: string;
  /** Older docs without the field read as "quote". */
  kind: QuoteKind;

  status: QuoteStatus;

  /** ISO 4217, default "USD". */
  currency: string;
  lineItems: QuoteLineItem[];
  /** Applied before tax. */
  globalDiscount: QuoteDiscount;
  /** 0-100, applied to (subtotal - discount). Null = no tax. */
  globalTaxPercent: number | null;

  termsAndNotes: string;
  /** Billing entity shown to the recipient; can differ from `contact.company`. */
  billedToOrganization: string | null;
  /** Snapshotted from the contact when picked; editable per document. */
  billingAddress: string | null;
  /** Null = no expiry. Quotes only; invoices don't expire. */
  validUntil: Timestamp | FieldValue | null;
  /**
   * Invoices only. 0 = due on receipt, null = no due date. Display label
   * only; nothing flips to overdue.
   */
  paymentDueDays: number | null;

  /**
   * On accept, create a Won deal with the quote total. Ignored when `dealId`
   * is set (that deal is moved instead).
   */
  autoCreateDealOnAccept: boolean;
  /**
   * Existing deal this quote is the proposal for. Accepting moves it to Won
   * and sets its value, avoiding a duplicate Won deal. Must belong to the same
   * contact + sub-account. If the deal was deleted, falls back to auto-create.
   */
  dealId?: string | null;

  sentAt: Timestamp | FieldValue | null;
  viewedAt: Timestamp | FieldValue | null;
  acceptedAt: Timestamp | FieldValue | null;
  declinedAt: Timestamp | FieldValue | null;
  declineReason: DeclineReason | null;
  declineNote: string | null;
  paidAt: Timestamp | FieldValue | null;
  /** Null unless this invoice was converted from an accepted quote. */
  convertedFromQuoteAt: Timestamp | FieldValue | null;

  /** Invoices only. Cached so a re-send reuses it; null until sent. */
  paymentLinkUrl: string | null;
  /** plink_... id, used to deactivate the old link when an edited invoice gets a new one. */
  paymentLinkId: string | null;
  /** Compared to `updatedAt` on send: edited since mint = deactivate and re-mint. */
  paymentLinkMintedAt: Timestamp | FieldValue | null;

  /** SHA-256 hex of the HMAC-signed public token. The raw token is never stored. */
  publicTokenHash: string;

  /**
   * Inherited from the contact and kept in sync on re-tag. Null on older
   * docs. Ignored unless `territoryScopingEnabled`.
   */
  territoryId?: string | null;

  createdAt: Timestamp | FieldValue | null;
  updatedAt: Timestamp | FieldValue | null;
}

/** The CRUD helper fills in id, tenancy, contactId, number, hash and timestamps. */
export const DEFAULT_QUOTE: Omit<
  Quote,
  | "id"
  | "agencyId"
  | "subAccountId"
  | "createdByUid"
  | "contactId"
  | "quoteNumber"
  | "publicTokenHash"
  | "createdAt"
  | "updatedAt"
> = {
  kind: "quote",
  status: "draft",
  currency: "USD",
  lineItems: [],
  globalDiscount: null,
  globalTaxPercent: null,
  termsAndNotes: "",
  billedToOrganization: null,
  billingAddress: null,
  validUntil: null,
  paymentDueDays: null,
  autoCreateDealOnAccept: true,
  dealId: null,
  sentAt: null,
  viewedAt: null,
  acceptedAt: null,
  declinedAt: null,
  declineReason: null,
  declineNote: null,
  paidAt: null,
  convertedFromQuoteAt: null,
  paymentLinkUrl: null,
  paymentLinkId: null,
  paymentLinkMintedAt: null,
};

/** Body of the public accept/decline POST. */
export interface QuoteRespondPayload {
  action: "accept" | "decline";
  /** Required for decline. */
  reason?: DeclineReason;
  /** Required when reason is "Other". */
  note?: string;
}
