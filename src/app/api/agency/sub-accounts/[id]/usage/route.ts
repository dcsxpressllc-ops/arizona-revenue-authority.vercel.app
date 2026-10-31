import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireAgencyOwner } from "@/lib/auth/require-tenancy";
import {
  computeFeatureFees,
  computeOverage,
  getEffectiveBilling,
  usageMonthKey,
} from "@/lib/server/usage-meter";
import { carriedInFor, type UsageClosedSnapshot } from "@/lib/server/usage-billing-service";
import type { AgencyUsageResponse, UsageMonthRow } from "@/types/usage-billing";
import type { UsageMonthDoc } from "@/types/usage";
import type { SubAccountDoc } from "@/types";

/**
 * Owner-only read of a workspace's usage ledger for the Manage dialog's
 * Billing & usage tab: this month plus the two before it, the rebilling
 * state, this month's running estimate, last month's close, the raw
 * overrides next to the plan's values (for the editor) and the AI cost.
 * The ledger is server-only in rules, so this is the only read path.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const db = getAdminDb();
  const subSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  if (!subSnap.exists) {
    return NextResponse.json({ error: "Sub-account not found" }, { status: 404 });
  }
  const sub = subSnap.data() as SubAccountDoc;

  const access = await requireAgencyOwner(request, sub.agencyId);
  if (access instanceof NextResponse) return access;

  const now = new Date();
  const months: string[] = [0, 1, 2].map((back) =>
    usageMonthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1))),
  );
  const [agencySnap, planSnap, ...snaps] = await Promise.all([
    db.doc(`agencies/${sub.agencyId}`).get(),
    sub.billing?.planId
      ? db.doc(`agencies/${sub.agencyId}/plans/${sub.billing.planId}`).get()
      : Promise.resolve(null),
    ...months.map((m) => db.doc(`subAccounts/${subAccountId}/usage/${m}`).get()),
  ]);
  const docs = snaps.map(
    (s) => (s.data() as (UsageMonthDoc & { closed?: UsageClosedSnapshot }) | undefined) ?? {},
  );
  const usage: UsageMonthRow[] = months.map((month, i) => {
    const d = docs[i];
    return {
      month,
      emailsSent: d.emailsSent ?? 0,
      smsSegments: d.smsSegments ?? 0,
      smsSegmentsShared: d.smsSegmentsShared ?? 0,
      whatsappMessages: d.whatsappMessages ?? 0,
      aiTokens: d.aiTokens ?? 0,
      aiReplies: d.aiReplies ?? 0,
      voiceSeconds: d.voiceSeconds ?? 0,
      webVoiceSeconds: d.webVoiceSeconds ?? 0,
      softphoneSeconds: d.softphoneSeconds ?? 0,
      firecrawlScrapes: d.firecrawlScrapes ?? 0,
      aiCostMicros: d.aiCostMicros ?? 0,
      aiCostBySource: d.aiCostBySource ?? {},
    };
  });

  const billing = await getEffectiveBilling(subAccountId, sub);
  const currency = (sub.billing?.currency as string | null) ?? "usd";
  const current = docs[0];
  const prevClosed = docs[1].closed;

  // Only a rebilled client accrues anything; otherwise rates and fees are inert.
  const overage = billing.rebilling
    ? computeOverage(current, billing.quotas, billing.rates)
    : { perUnit: {}, totalCents: 0 };
  const fees = billing.rebilling
    ? computeFeatureFees(current, billing.featureFees)
    : { lines: [], totalCents: 0 };
  const carriedInCents = billing.rebilling
    ? (await carriedInFor(subAccountId, months[0], currency)).cents
    : 0;

  const plan = planSnap?.exists ? planSnap.data() : null;
  const body: AgencyUsageResponse = {
    usage,
    quotas: billing.quotas,
    rates: billing.rates,
    currency,
    quotaSource: sub.usageQuotas
      ? "workspace"
      : sub.billing?.planId && billing.quotas
        ? "plan"
        : "none",
    overage,
    fees,
    carriedInCents,
    estimatedCents: overage.totalCents + fees.totalCents + carriedInCents,
    spendCapCents: billing.spendCapCents,
    rebilling: {
      active: billing.rebilling,
      agency: agencySnap.data()?.usageRebillingEnabled === true,
      client: sub.usageRebillingEnabled === true,
    },
    lastClosed: prevClosed
      ? {
          month: months[1],
          skipped: prevClosed.skipped === true,
          totalCents: prevClosed.totalCents ?? 0,
          carryOutCents: prevClosed.carryOutCents ?? 0,
          chargeId: prevClosed.chargeId ?? null,
        }
      : null,
    config: {
      overrides: {
        usageQuotas: sub.usageQuotas ?? null,
        usageRates: sub.usageRates ?? null,
        usageSpendCapCents: sub.usageSpendCapCents ?? null,
        featureFees: sub.featureFees ?? null,
      },
      plan: plan
        ? {
            name: String(plan.name ?? ""),
            quotas: plan.quotas ?? null,
            rates: plan.rates ?? null,
            spendCapCents: plan.spendCapCents ?? null,
            featureFees: plan.featureFees ?? null,
          }
        : null,
      dedicatedSms: sub.twilioConfig?.enabled === true,
    },
  };
  return NextResponse.json(body);
}
