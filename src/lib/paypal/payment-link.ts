import "server-only";

import type { Quote } from "@/types/quotes";
import type { PayPalConfig } from "@/types";
import { computeQuoteTotals } from "@/lib/quotes/calc";

/**
 * paypal.me URL for an invoice: `https://paypal.me/{username}/{amount}{currency}`.
 * Without a currency PayPal uses the merchant's primary one. Unsupported codes
 * fall back to USD since paypal.me silently ignores unknown ones.
 *
 * No API call; payments land in the merchant's balance and are confirmed
 * off-system before the operator marks the invoice paid.
 */

const PAYPAL_ME_CURRENCIES = new Set([
  "USD", "GBP", "EUR", "AUD", "CAD", "BRL", "CHF", "CZK", "DKK", "HKD",
  "HUF", "ILS", "JPY", "MXN", "NOK", "NZD", "PHP", "PLN", "RUB", "SEK",
  "SGD", "THB", "TWD",
]);

export function buildPaypalInvoiceUrl({
  paypal,
  invoice,
}: {
  paypal: PayPalConfig;
  invoice: Quote;
}): string {
  if (invoice.kind !== "invoice") {
    throw new Error("buildPaypalInvoiceUrl: quote.kind must be 'invoice'");
  }
  const totals = computeQuoteTotals(invoice);
  if (totals.total <= 0) {
    throw new Error(
      `Invoice ${invoice.quoteNumber} has a non-positive total — add line items before sending.`,
    );
  }

  // Two decimals, but integers drop them (100, not 100.00).
  const amountStr =
    totals.total % 1 === 0
      ? String(totals.total)
      : totals.total.toFixed(2);

  const currency = (invoice.currency || "USD").toUpperCase();
  const currencySuffix = PAYPAL_ME_CURRENCIES.has(currency) ? currency : "";

  // Sanitized at save already; also strip a stray leading slash or `paypal.me/`.
  const username = paypal.username
    .replace(/^https?:\/\//i, "")
    .replace(/^(www\.)?paypal\.me\//i, "")
    .replace(/^\//, "");

  return `https://paypal.me/${encodeURIComponent(username)}/${amountStr}${currencySuffix}`;
}

/** Same URL format with an explicit amount + currency, for booking deposits (released once the operator marks paid). */
export function buildPaypalAmountUrl({
  paypal,
  amount,
  currency,
}: {
  paypal: PayPalConfig;
  amount: number;
  currency: string;
}): string {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("buildPaypalAmountUrl: amount must be > 0");
  }
  const amountStr = amount % 1 === 0 ? String(amount) : amount.toFixed(2);
  const upper = currency.toUpperCase();
  const currencySuffix = PAYPAL_ME_CURRENCIES.has(upper) ? upper : "";
  const username = paypal.username
    .replace(/^https?:\/\//i, "")
    .replace(/^(www\.)?paypal\.me\//i, "")
    .replace(/^\//, "");
  return `https://paypal.me/${encodeURIComponent(username)}/${amountStr}${currencySuffix}`;
}
