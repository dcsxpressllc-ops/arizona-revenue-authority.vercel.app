import type { SubAccountBilling } from "@/types/billing";
import type { UsageOverdue } from "@/types/tenancy";
import { BILLING_GRACE_DAYS } from "@/types/billing";
import {
  billingDateToMillis,
  effectiveBillingState,
  type EffectiveBillingState,
} from "@/lib/billing/status";

/** Guard state from the subscription and unpaid usage; a comped client can still owe usage. */

const DAY_MS = 24 * 60 * 60 * 1000;

export type UsageDebtState = "none" | "grace" | "lapsed";

/** Overdue usage: grace for BILLING_GRACE_DAYS after the due date, then lapsed. */
export function usageDebtState(
  overdue: UsageOverdue | null | undefined,
  now: Date = new Date(),
): UsageDebtState {
  if (!overdue) return "none";
  const sinceMs = billingDateToMillis(overdue.since);
  if (sinceMs === null) return "none";
  return now.getTime() < sinceMs + BILLING_GRACE_DAYS * DAY_MS ? "grace" : "lapsed";
}

/** When the usage grace period ends, or null when nothing is overdue. */
export function usageGraceEndsAt(overdue: UsageOverdue | null | undefined): number | null {
  const sinceMs = billingDateToMillis(overdue?.since ?? null);
  return sinceMs === null ? null : sinceMs + BILLING_GRACE_DAYS * DAY_MS;
}

export interface WorkspaceBillingState {
  state: EffectiveBillingState;
  /** Which debt causes a grace/lapsed/pending state; null when nothing does. */
  blockedBy: "plan" | "usage" | null;
}

export function workspaceBillingState(
  billing: SubAccountBilling | null | undefined,
  usageOverdue: UsageOverdue | null | undefined,
  now: Date = new Date(),
): WorkspaceBillingState {
  const plan = effectiveBillingState(billing, now);
  // An unpaid subscription is the bigger problem, so it shows first.
  if (plan === "pending" || plan === "lapsed") return { state: plan, blockedBy: "plan" };
  const usage = usageDebtState(usageOverdue, now);
  if (usage === "lapsed") return { state: "lapsed", blockedBy: "usage" };
  if (plan === "grace") return { state: "grace", blockedBy: "plan" };
  if (usage === "grace") return { state: "grace", blockedBy: "usage" };
  return { state: plan, blockedBy: null };
}
