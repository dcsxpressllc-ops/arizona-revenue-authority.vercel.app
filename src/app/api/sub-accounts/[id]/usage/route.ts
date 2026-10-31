import "server-only";

import { NextResponse } from "next/server";
import { Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import {
  computeFeatureFees,
  computeOverage,
  getEffectiveBilling,
  unitIsPriced,
  usageMonthKey,
} from "@/lib/server/usage-meter";
import { USAGE_UNIT_META } from "@/lib/billing/usage-units";
import { carriedInFor } from "@/lib/server/usage-billing-service";
import type { ClientUsageResponse } from "@/types/usage-billing";
import type { UsageChargeLine } from "@/types/billing";
import type { UsageMonthDoc, UsageUnit } from "@/types/usage";
import type { SubAccountDoc } from "@/types";

/** The client's usage billing view. Never returns costs or unpriced rates. */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const db = getAdminDb();
  const subSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  if (!subSnap.exists) {
    return NextResponse.json({ error: "Sub-account not found" }, { status: 404 });
  }
  const sub = subSnap.data() as SubAccountDoc;
  const month = usageMonthKey();
  const [ledgerSnap, chargesSnap] = await Promise.all([
    db.doc(`subAccounts/${subAccountId}/usage/${month}`).get(),
    db
      .collection("billingCharges")
      .where("subAccountId", "==", subAccountId)
      .where("kind", "==", "usage")
      .get(),
  ]);

  const billing = await getEffectiveBilling(subAccountId, sub);
  const currency = (sub.billing?.currency as string | null) ?? "usd";
  const usage = (ledgerSnap.data() as UsageMonthDoc | undefined) ?? {};

  const charges = chargesSnap.docs
    .map((d) => d.data())
    // Defence in depth: the query is already scoped to this workspace.
    .filter((c) => c.agencyId === sub.agencyId && c.status !== "canceled")
    .map((c) => ({
      id: String(c.id),
      month: typeof c.usageMonth === "string" ? c.usageMonth : null,
      amountCents: Number(c.amountCents ?? 0),
      currency: String(c.currency ?? currency),
      status: (c.status === "paid" ? "paid" : "pending") as "paid" | "pending",
      dueAt: c.dueAt instanceof Timestamp ? c.dueAt.toDate().toISOString() : null,
      paidAt: c.paidAt instanceof Timestamp ? c.paidAt.toDate().toISOString() : null,
      lineItems: (c.lineItems as UsageChargeLine[] | undefined) ?? [],
    }))
    .sort((a, b) => (b.month ?? "").localeCompare(a.month ?? ""));
  const unpaid = charges.some((c) => c.status === "pending");

  if (!billing.rebilling) {
    const body: ClientUsageResponse = {
      show: unpaid,
      rebilled: false,
      month,
      currency,
      units: [],
      fees: [],
      carriedInCents: 0,
      estimatedCents: 0,
      spendCap: null,
      charges: unpaid ? charges : [],
    };
    return NextResponse.json(body);
  }

  const overage = computeOverage(usage, billing.quotas, billing.rates);
  const fees = computeFeatureFees(usage, billing.featureFees);
  // SMS on the client's own Twilio is never billed, so a plan SMS rate isn't shown.
  const ownTwilio = sub.twilioConfig?.enabled === true;
  const units = USAGE_UNIT_META.filter(
    (u) =>
      unitIsPriced(u.field as UsageUnit, billing.rates) &&
      // Still shown if shared-number SMS from earlier this month is billed.
      !(u.field === "smsSegments" && ownTwilio && !overage.perUnit.smsSegments),
  ).map((u) => {
    const quota = billing.quotas?.[u.quotaKey];
    const factor = u.minutes ? 60 : 1;
    const over = overage.perUnit[u.field as UsageUnit];
    return {
      label: u.label,
      minutes: u.minutes,
      used: (usage[u.billableField as keyof UsageMonthDoc] as number | undefined) ?? 0,
      included: typeof quota === "number" && quota > 0 ? quota * factor : 0,
      billableUnits: over?.overUnits ?? 0,
      cents: over?.cents ?? 0,
      rateCents: billing.rates?.[u.rateKey!] ?? 0,
    };
  });
  const carriedInCents = true
    ? (await carriedInFor(subAccountId, month, currency)).cents
    : 0;

  const body: ClientUsageResponse = {
    show: units.length > 0 || fees.lines.length > 0 || charges.length > 0,
    rebilled: true,
    month,
    currency,
    units,
    fees: fees.lines.map((l) => ({ label: l.label, cents: l.cents })),
    carriedInCents,
    estimatedCents: overage.totalCents + fees.totalCents + carriedInCents,
    spendCap:
      billing.spendCapCents !== null
        ? { cents: billing.spendCapCents, usedCents: overage.totalCents }
        : null,
    charges,
  };
  return NextResponse.json(body);
}
