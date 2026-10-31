import "server-only";

import { NextResponse } from "next/server";
import { requireAgencyOwnerAny } from "@/lib/auth/require-tenancy";
import {
  BillingError,
  normalizePlanGates,
  updatePlanForAgency,
  validateAnnualPrice,
  validatePlanPricing,
} from "@/lib/server/billing-service";
import {
  sanitizeUsageQuotas,
  invalidateUsageBillingCache,
  validateFeatureFees,
  validateSpendCap,
  validateUsageRates,
} from "@/lib/server/usage-meter";

function billingErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof BillingError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  return null;
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ planId: string }> },
) {
  const caller = await requireAgencyOwnerAny(request);
  if (caller instanceof NextResponse) return caller;
  const { planId } = await ctx.params;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const patch: Parameters<typeof updatePlanForAgency>[0] = {
    agencyId: caller.agencyId!,
    planId,
  };

  if (typeof body.name === "string") {
    const name = body.name.trim();
    if (!name || name.length > 60) {
      return NextResponse.json(
        { error: "Plan name must be 1–60 characters." },
        { status: 400 },
      );
    }
    patch.name = name;
  }
  if (typeof body.description === "string" || body.description === null) {
    const description =
      typeof body.description === "string" ? body.description.trim() : "";
    if (description.length > 300) {
      return NextResponse.json(
        { error: "Description must be 300 characters or fewer." },
        { status: 400 },
      );
    }
    patch.description = description || null;
  }
  if (body.priceMonthlyCents !== undefined) {
    try {
      // Currency is fixed after creation, so validate with a placeholder.
      const { priceMonthlyCents } = validatePlanPricing(
        body.priceMonthlyCents,
        "usd",
      );
      patch.priceMonthlyCents = priceMonthlyCents;
    } catch (err) {
      const res = billingErrorResponse(err);
      if (res) return res;
      throw err;
    }
  }
  if (body.priceAnnualCents !== undefined) {
    try {
      // null removes annual pricing; undefined is filtered out above.
      patch.priceAnnualCents = validateAnnualPrice(body.priceAnnualCents);
    } catch (err) {
      const res = billingErrorResponse(err);
      if (res) return res;
      throw err;
    }
  }
  if (body.gates !== undefined) {
    patch.gates = normalizePlanGates(body.gates);
  }
  // undefined = untouched; otherwise sanitized to a map or null (unlimited)
  if (body.quotas !== undefined) {
    patch.quotas = sanitizeUsageQuotas(body.quotas);
  }
  if (body.rates !== undefined) {
    const v = validateUsageRates(body.rates);
    if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
    patch.rates = v.rates;
  }
  if (body.spendCapCents !== undefined) {
    const v = validateSpendCap(body.spendCapCents);
    if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
    patch.spendCapCents = v.cents;
  }
  if (body.featureFees !== undefined) {
    const v = validateFeatureFees(body.featureFees);
    if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
    patch.featureFees = v.fees;
  }
  if (body.status === "active" || body.status === "archived") {
    patch.status = body.status;
  }

  try {
    const plan = await updatePlanForAgency(patch);
    invalidateUsageBillingCache();
    return NextResponse.json({ plan });
  } catch (err) {
    const res = billingErrorResponse(err);
    if (res) return res;
    console.error("[api/agency/plans] update failed", err);
    return NextResponse.json(
      { error: "Failed to update the plan." },
      { status: 500 },
    );
  }
}

/** Archives rather than deletes; live subscriptions may still reference the plan. */
export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ planId: string }> },
) {
  const caller = await requireAgencyOwnerAny(request);
  if (caller instanceof NextResponse) return caller;
  const { planId } = await ctx.params;

  try {
    const plan = await updatePlanForAgency({
      agencyId: caller.agencyId!,
      planId,
      status: "archived",
    });
    return NextResponse.json({ plan });
  } catch (err) {
    const res = billingErrorResponse(err);
    if (res) return res;
    console.error("[api/agency/plans] archive failed", err);
    return NextResponse.json(
      { error: "Failed to archive the plan." },
      { status: 500 },
    );
  }
}
