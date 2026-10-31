import type { SubAccountDoc } from "@/types/tenancy";

/**
 * "Can this sub-account collect money from its customers?" One predicate on
 * purpose: the old "has a paypal.me username" check was copied into seven
 * places, and adding a card rail meant each silently blocked Stripe-only
 * workspaces. Import this instead of reading `paypalConfig`; a new rail goes
 * here only. Client-safe so editors match what the API enforces.
 */

/** Loose so callers can pass a partial/raw doc. */
type PaymentCapableSub = Pick<
  SubAccountDoc,
  "paypalConfig" | "paymentsEnabledByAgency" | "stripeConnectionMeta"
>;

/** paypal.me links: stateless, no confirmation callback. */
export function hasPaypalRail(
  sub: Partial<PaymentCapableSub> | null | undefined,
): boolean {
  return !!sub?.paypalConfig?.username;
}

/**
 * Card via the sub-account's own Stripe: agency gate plus a connection that
 * can confirm payments. `ready === false` means the webhook step isn't done,
 * so a payment would succeed with nothing to mark the order paid; treated as
 * no card rail.
 */
export function hasCardRail(
  sub: Partial<PaymentCapableSub> | null | undefined,
): boolean {
  return (
    sub?.paymentsEnabledByAgency === true &&
    sub?.stripeConnectionMeta?.ready === true
  );
}

export function canTakePayment(
  sub: Partial<PaymentCapableSub> | null | undefined,
): boolean {
  return hasPaypalRail(sub) || hasCardRail(sub);
}

export const NO_PAYMENT_RAIL_MESSAGE =
  "Connect Stripe or PayPal under Settings → Payments first.";
