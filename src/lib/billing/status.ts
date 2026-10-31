import type { BillingInterval, SubAccountBilling } from "@/types/billing";

/**
 * Decides whether a sub-account renders normally, shows the dunning banner, or
 * is paywalled. The paywall, settings card and agency client table all use this
 * so they agree.
 *
 * Grace is evaluated at read time against `graceUntil` (no cron): past_due
 * inside the window is "grace", after it "lapsed". Client-safe on purpose; the
 * paywall computes it in the browser.
 */

export type EffectiveBillingState =
  /** No billing / comped: never paywalled, gates are manual. */
  | "comped"
  /** Plan assigned, not yet paid: activation paywall. */
  | "pending"
  | "active"
  /** Renewal failed, inside grace: dunning banner. */
  | "grace"
  /** Grace exhausted or canceled: hard paywall. */
  | "lapsed";

/** Timestamp / Date / null to epoch millis. */
export function billingDateToMillis(
  value: SubAccountBilling["graceUntil"],
): number | null {
  if (!value) return null;
  if (value instanceof Date) return value.getTime();
  if (
    typeof value === "object" &&
    "toMillis" in value &&
    typeof value.toMillis === "function"
  ) {
    return value.toMillis();
  }
  return null;
}

export function effectiveBillingState(
  billing: SubAccountBilling | null | undefined,
  now: Date = new Date(),
): EffectiveBillingState {
  if (!billing || billing.status === "comped") return "comped";
  switch (billing.status) {
    case "pending":
      return "pending";
    case "active":
      return "active";
    case "past_due": {
      const graceMs = billingDateToMillis(billing.graceUntil);
      return graceMs !== null && graceMs > now.getTime() ? "grace" : "lapsed";
    }
    case "canceled":
      return "lapsed";
  }
}

export function billingBlocksWorkspace(state: EffectiveBillingState): boolean {
  return state === "pending" || state === "lapsed";
}

/** "$97.00 AUD" from integer cents and a lowercase ISO currency. */
export function formatBillingPrice(
  priceCents: number | null | undefined,
  currency: string | null | undefined,
): string {
  if (typeof priceCents !== "number" || !currency) return "—";
  const code = currency.toUpperCase();
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code,
      currencyDisplay: "narrowSymbol",
    }).format(priceCents / 100);
  } catch {
    return `${(priceCents / 100).toFixed(2)} ${code}`;
  }
}

export function billingIntervalSuffix(
  interval: BillingInterval | null | undefined,
): string {
  return interval === "year" ? "/yr" : "/mo";
}

/** "$990.00 AUD/yr". Monthly when interval is null. */
export function formatBillingPriceWithInterval(
  priceCents: number | null | undefined,
  currency: string | null | undefined,
  interval: BillingInterval | null | undefined,
): string {
  const base = formatBillingPrice(priceCents, currency);
  if (base === "—") return base;
  return `${base}${billingIntervalSuffix(interval)}`;
}

/** Monthly equivalent for MRR (annual / 12). */
export function monthlyEquivalentCents(
  priceCents: number | null | undefined,
  interval: BillingInterval | null | undefined,
): number {
  if (typeof priceCents !== "number") return 0;
  return interval === "year" ? priceCents / 12 : priceCents;
}
