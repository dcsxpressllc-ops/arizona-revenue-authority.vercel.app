import type { Quote, QuoteLineItem, QuoteStatus } from "@/types/quotes";

/**
 * Pure quote money math, shared by the builder preview, public quote page,
 * email template and the accept -> deal flow (deal value = total).
 *
 * Values are decimal (not cents) in the quote's currency, rounded to 2dp only
 * at the final step so line-by-line rounding doesn't stack. One global tax %
 * on (subtotal - discount); no per-line tax.
 */

export interface QuoteTotals {
  /** Sum of qty x unitPrice. */
  subtotal: number;
  /** Positive amount taken off subtotal. 0 when no discount. */
  discountAmount: number;
  /** subtotal - discount; the tax base. */
  taxableAmount: number;
  /** 0 when tax is null. */
  taxAmount: number;
  /** taxable + tax, 2dp. */
  total: number;
}

/** Safe mid-edit; empty lineItems gives zeros. */
export function computeQuoteTotals(
  quote: Pick<Quote, "lineItems" | "globalDiscount" | "globalTaxPercent">,
): QuoteTotals {
  const subtotal = quote.lineItems.reduce(
    (acc, item) => acc + lineItemSubtotal(item),
    0,
  );

  let discountAmount = 0;
  if (quote.globalDiscount) {
    if (quote.globalDiscount.type === "percent") {
      const pct = clamp(quote.globalDiscount.value, 0, 100);
      discountAmount = (subtotal * pct) / 100;
    } else {
      discountAmount = Math.max(0, quote.globalDiscount.value);
    }
  }
  discountAmount = Math.min(discountAmount, subtotal);

  const taxableAmount = subtotal - discountAmount;

  let taxAmount = 0;
  if (quote.globalTaxPercent != null) {
    const pct = clamp(quote.globalTaxPercent, 0, 100);
    taxAmount = (taxableAmount * pct) / 100;
  }

  const total = round2(taxableAmount + taxAmount);

  return {
    subtotal: round2(subtotal),
    discountAmount: round2(discountAmount),
    taxableAmount: round2(taxableAmount),
    taxAmount: round2(taxAmount),
    total,
  };
}

/** qty x unitPrice, clamped >= 0. */
export function lineItemSubtotal(item: QuoteLineItem): number {
  const qty = Math.max(0, item.quantity);
  const price = Math.max(0, item.unitPrice);
  return qty * price;
}

/**
 * Read-time expiry, so the public page blocks accepting an expired quote and
 * the list shows "Expired" without a background sweep. True when validUntil
 * is past and the quote isn't accepted, paid or declined.
 */
export function isQuoteExpired(
  quote: Pick<Quote, "status" | "validUntil">,
  now: Date = new Date(),
): boolean {
  if (
    quote.status === "accepted" ||
    quote.status === "declined" ||
    quote.status === "paid"
  ) {
    return false;
  }
  if (!quote.validUntil) return false;
  const ts = quote.validUntil as { toMillis?: () => number; seconds?: number };
  let validUntilMs: number;
  if (typeof ts.toMillis === "function") {
    validUntilMs = ts.toMillis();
  } else if (typeof ts.seconds === "number") {
    validUntilMs = ts.seconds * 1000;
  } else {
    return false;
  }
  return validUntilMs < now.getTime();
}

/** Stored status, or "expired" from the read-time check. For badges; use `quote.status` for sorting/analytics. */
export function effectiveQuoteStatus(
  quote: Pick<Quote, "status" | "validUntil">,
  now: Date = new Date(),
): QuoteStatus {
  return isQuoteExpired(quote, now) ? "expired" : quote.status;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function round2(n: number): number {
  // Half away from zero, matching Intl.NumberFormat so displayed and stored values agree.
  return Math.round(n * 100) / 100;
}
