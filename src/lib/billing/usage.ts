/**
 * Client-safe constants and helpers for monthly usage billing, shared by the
 * month-close cron, the emails and the billing UIs.
 */

/** A month's total below this carries into the next month's charge instead. */
export const USAGE_MIN_CHARGE_CENTS = 500;

/** Days a client has to pay a usage charge before it's overdue. */
export const USAGE_PAYMENT_TERMS_DAYS = 14;

/** First reminder goes out this many days before the due date. */
export const USAGE_REMINDER_DAYS_BEFORE = 3;

/** "YYYY-MM" for the month before `d` (UTC, like the ledger). */
export function previousMonthKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth(); // 0-based; the previous month is m - 1
  const prev = new Date(Date.UTC(y, m - 1, 1));
  return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The month before a "YYYY-MM" key. */
export function monthBefore(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return previousMonthKey(new Date(Date.UTC(y, m - 1, 15)));
}

/** First instant after the month ends (UTC). */
export function monthEndExclusive(key: string): Date {
  const [y, m] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m, 1));
}

/** Month name and year. */
export function formatUsageMonth(key: string): string {
  const [y, m] = key.split("-").map(Number);
  if (!y || !m) return key;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
