import "server-only";

import type Stripe from "stripe";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getStripeServer } from "@/lib/stripe/server";
import { applyFeatureGates } from "@/lib/server/feature-gates-service";
import {
  buildChargeCheckoutUrl,
  buildCheckoutUrl,
  issueChargeToken,
  issueCheckoutToken,
} from "@/lib/billing/token";
import { emitWebhookEvent } from "@/lib/api/webhooks/dispatch";
import {
  BILLING_GRACE_DAYS,
  PLAN_GATE_KEYS,
  type BillingChargeDoc,
  type BillingChargeResponse,
  type BillingChargeStatus,
  type BillingInterval,
  type BillingPlanDoc,
  type BillingPlanResponse,
  type PlanGates,
  type SubAccountBilling,
  type SubAccountBillingStatus,
  type UsageChargeLine,
} from "@/types/billing";

/**
 * Single write path for agency plans (agencies/{agencyId}/plans/{planId}) and
 * per-sub-account billing (subAccounts/{id}.billing). Charges run on the
 * deployment's own Stripe account, no Connect. Callers do auth.
 *
 * Stripe mapping:
 *   - plan create: Product + recurring monthly Price
 *   - price edit: new Price (Prices are immutable), old one deactivated;
 *     existing subscriptions keep their price
 *   - special price: one-off Price on the plan's Product for one sub-account
 *   - checkout: mode "subscription" with metadata.kind = "subAccountPlan" on
 *     both session and subscription, so the webhook never confuses it with the
 *     founders / user-subscription branches
 */

export const SUB_ACCOUNT_PLAN_KIND = "subAccountPlan";
/** metadata.kind for one-time charges (mode "payment"). */
export const SUB_ACCOUNT_CHARGE_KIND = "subAccountCharge";

/** Stripe's practical floor for a recurring charge, in cents. */
const MIN_PRICE_CENTS = 100;
const MAX_PRICE_CENTS = 100_000_000;

export function billingStripeIsConfigured(): boolean {
  return !!process.env.STRIPE_SECRET_KEY?.trim();
}

export class BillingError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "BillingError";
    this.status = status;
  }
}

function plansCollection(agencyId: string) {
  return getAdminDb().collection(`agencies/${agencyId}/plans`);
}

/**
 * Append-only audit trail in billingEvents: one row per assignment, comp,
 * activation and dunning change, so "who put this client on what" doesn't need
 * Stripe. Best-effort.
 */
function recordBillingEvent(entry: {
  agencyId: string;
  subAccountId: string;
  event:
    | "plan.assigned"
    | "plan.switched"
    | "comped"
    | "activated"
    | "status.changed"
    | "charge.created"
    | "charge.paid"
    | "charge.canceled";
  detail: Record<string, unknown>;
}): void {
  getAdminDb()
    .collection("billingEvents")
    .add({
      ...entry,
      createdAt: FieldValue.serverTimestamp(),
    })
    .catch((err) =>
      console.warn("[billing] failed to record billing event", err),
    );
}

function tsToIso(value: unknown): string | null {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  return null;
}

function serializePlan(
  id: string,
  data: FirebaseFirestore.DocumentData,
): BillingPlanResponse {
  const gates = {} as PlanGates;
  for (const key of PLAN_GATE_KEYS) {
    gates[key] = data.gates?.[key] === true;
  }
  return {
    id,
    name: String(data.name ?? ""),
    description: (data.description as string | null) ?? null,
    priceMonthlyCents: Number(data.priceMonthlyCents ?? 0),
    priceAnnualCents:
      data.priceAnnualCents != null ? Number(data.priceAnnualCents) : null,
    currency: String(data.currency ?? "usd"),
    gates,
    quotas: (data.quotas as BillingPlanResponse["quotas"]) ?? null,
    rates: (data.rates as BillingPlanResponse["rates"]) ?? null,
    spendCapCents: (data.spendCapCents as number | undefined) ?? null,
    featureFees: (data.featureFees as BillingPlanResponse["featureFees"]) ?? null,
    status: data.status === "archived" ? "archived" : "active",
    createdAt: tsToIso(data.createdAt),
    updatedAt: tsToIso(data.updatedAt),
  };
}

export function normalizePlanGates(input: unknown): PlanGates {
  const source = (input ?? {}) as Record<string, unknown>;
  const gates = {} as PlanGates;
  for (const key of PLAN_GATE_KEYS) {
    gates[key] = source[key] === true;
  }
  return gates;
}

export function validatePlanPricing(
  priceMonthlyCents: unknown,
  currency: unknown,
): { priceMonthlyCents: number; currency: string } {
  if (
    typeof priceMonthlyCents !== "number" ||
    !Number.isInteger(priceMonthlyCents) ||
    priceMonthlyCents < MIN_PRICE_CENTS ||
    priceMonthlyCents > MAX_PRICE_CENTS
  ) {
    throw new BillingError(
      `priceMonthlyCents must be an integer between ${MIN_PRICE_CENTS} and ${MAX_PRICE_CENTS}.`,
    );
  }
  const cur = typeof currency === "string" ? currency.trim().toLowerCase() : "";
  if (!/^[a-z]{3}$/.test(cur)) {
    throw new BillingError(
      'currency must be a 3-letter ISO code (e.g. "usd", "aud").',
    );
  }
  return { priceMonthlyCents, currency: cur };
}

/** Optional annual price. Returns undefined = no change (edit path), null =
 *  monthly-only, or the number to set. */
export function validateAnnualPrice(
  priceAnnualCents: unknown,
): number | null | undefined {
  if (priceAnnualCents === undefined) return undefined;
  if (priceAnnualCents === null) return null;
  if (
    typeof priceAnnualCents !== "number" ||
    !Number.isInteger(priceAnnualCents) ||
    priceAnnualCents < MIN_PRICE_CENTS ||
    priceAnnualCents > MAX_PRICE_CENTS
  ) {
    throw new BillingError(
      `priceAnnualCents must be null or an integer between ${MIN_PRICE_CENTS} and ${MAX_PRICE_CENTS}.`,
    );
  }
  return priceAnnualCents;
}

// Plans

export async function listPlansForAgency(
  agencyId: string,
): Promise<BillingPlanResponse[]> {
  const snap = await plansCollection(agencyId).get();
  return snap.docs
    .map((d) => serializePlan(d.id, d.data()))
    .sort((a, b) => a.priceMonthlyCents - b.priceMonthlyCents);
}

export async function createPlanForAgency(input: {
  agencyId: string;
  name: string;
  description: string | null;
  priceMonthlyCents: number;
  /** Optional annual price; null = monthly-only. */
  priceAnnualCents: number | null;
  currency: string;
  gates: PlanGates;
  /** Included monthly quotas; null = unlimited. */
  quotas?: import("@/types/usage").UsageQuotas | null;
  /** Overage sell rates in cents; null = none. */
  rates?: import("@/types/usage").UsageRates | null;
  /** Monthly overage ceiling in cents; null = none. */
  spendCapCents?: number | null;
  /** Flat monthly fees by gate; null = none. */
  featureFees?: import("@/types/usage").FeatureFees | null;
}): Promise<BillingPlanResponse> {
  if (!billingStripeIsConfigured()) {
    throw new BillingError(
      "Stripe isn't configured on this deployment. Set STRIPE_SECRET_KEY to create plans.",
      503,
    );
  }
  const stripe = getStripeServer();
  const ref = plansCollection(input.agencyId).doc();

  const product = await stripe.products.create({
    name: input.name,
    ...(input.description ? { description: input.description } : {}),
    metadata: {
      kind: SUB_ACCOUNT_PLAN_KIND,
      agencyId: input.agencyId,
      planId: ref.id,
    },
  });
  const price = await stripe.prices.create({
    product: product.id,
    unit_amount: input.priceMonthlyCents,
    currency: input.currency,
    recurring: { interval: "month" },
    metadata: { planId: ref.id },
  });

  // Annual price is a second recurring Price on the same Product.
  let annualPriceId: string | null = null;
  if (input.priceAnnualCents !== null) {
    const annual = await stripe.prices.create({
      product: product.id,
      unit_amount: input.priceAnnualCents,
      currency: input.currency,
      recurring: { interval: "year" },
      metadata: { planId: ref.id, interval: "year" },
    });
    annualPriceId = annual.id;
  }

  await ref.set({
    id: ref.id,
    agencyId: input.agencyId,
    name: input.name,
    description: input.description,
    priceMonthlyCents: input.priceMonthlyCents,
    priceAnnualCents: input.priceAnnualCents,
    currency: input.currency,
    gates: input.gates,
    quotas: input.quotas ?? null,
    rates: input.rates ?? null,
    spendCapCents: input.spendCapCents ?? null,
    featureFees: input.featureFees ?? null,
    status: "active",
    stripeProductId: product.id,
    stripePriceId: price.id,
    stripeAnnualPriceId: annualPriceId,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  const snap = await ref.get();
  return serializePlan(ref.id, snap.data() ?? {});
}

export async function updatePlanForAgency(input: {
  agencyId: string;
  planId: string;
  name?: string;
  description?: string | null;
  priceMonthlyCents?: number;
  /** undefined = no change; null = remove annual; number = set/change annual. */
  priceAnnualCents?: number | null;
  gates?: PlanGates;
  /** undefined = no change; null = clear (unlimited); object = set. */
  quotas?: import("@/types/usage").UsageQuotas | null;
  /** undefined = no change; null = clear; object = set. */
  rates?: import("@/types/usage").UsageRates | null;
  /** undefined = no change; null = clear. */
  spendCapCents?: number | null;
  /** undefined = no change; null = clear; object = set. */
  featureFees?: import("@/types/usage").FeatureFees | null;
  status?: "active" | "archived";
}): Promise<BillingPlanResponse> {
  const ref = plansCollection(input.agencyId).doc(input.planId);
  const snap = await ref.get();
  if (!snap.exists) throw new BillingError("Plan not found", 404);
  const plan = snap.data() as BillingPlanDoc & Record<string, unknown>;

  const updates: Record<string, unknown> = {
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (typeof input.name === "string") updates.name = input.name;
  if (input.description !== undefined) updates.description = input.description;
  if (input.gates) updates.gates = input.gates;
  if (input.quotas !== undefined) updates.quotas = input.quotas;
  if (input.rates !== undefined) updates.rates = input.rates;
  if (input.spendCapCents !== undefined) updates.spendCapCents = input.spendCapCents;
  if (input.featureFees !== undefined) updates.featureFees = input.featureFees;
  if (input.status) updates.status = input.status;

  const stripe = billingStripeIsConfigured() ? getStripeServer() : null;

  // New Price, old one deactivated. Existing subscriptions keep theirs; only new
  // checkouts see the new amount.
  if (
    typeof input.priceMonthlyCents === "number" &&
    input.priceMonthlyCents !== plan.priceMonthlyCents
  ) {
    if (!stripe || !plan.stripeProductId) {
      throw new BillingError(
        "Stripe isn't configured — can't change the plan price.",
        503,
      );
    }
    const price = await stripe.prices.create({
      product: plan.stripeProductId,
      unit_amount: input.priceMonthlyCents,
      currency: plan.currency,
      recurring: { interval: "month" },
      metadata: { planId: input.planId },
    });
    if (plan.stripePriceId) {
      await stripe.prices
        .update(plan.stripePriceId, { active: false })
        .catch((err) =>
          console.warn("[billing] failed to deactivate old price", err),
        );
    }
    updates.priceMonthlyCents = input.priceMonthlyCents;
    updates.stripePriceId = price.id;
  }

  // undefined = untouched, null = remove (monthly-only), number = set/change.
  const currentAnnual = (plan.priceAnnualCents as number | null | undefined) ?? null;
  if (
    input.priceAnnualCents !== undefined &&
    input.priceAnnualCents !== currentAnnual
  ) {
    if (!stripe || !plan.stripeProductId) {
      throw new BillingError(
        "Stripe isn't configured — can't change the annual price.",
        503,
      );
    }
    if (input.priceAnnualCents === null) {
      if (plan.stripeAnnualPriceId) {
        await stripe.prices
          .update(plan.stripeAnnualPriceId, { active: false })
          .catch((err) =>
            console.warn("[billing] failed to deactivate annual price", err),
          );
      }
      updates.priceAnnualCents = null;
      updates.stripeAnnualPriceId = null;
    } else {
      const annual = await stripe.prices.create({
        product: plan.stripeProductId,
        unit_amount: input.priceAnnualCents,
        currency: plan.currency,
        recurring: { interval: "year" },
        metadata: { planId: input.planId, interval: "year" },
      });
      if (plan.stripeAnnualPriceId) {
        await stripe.prices
          .update(plan.stripeAnnualPriceId, { active: false })
          .catch((err) =>
            console.warn("[billing] failed to deactivate old annual price", err),
          );
      }
      updates.priceAnnualCents = input.priceAnnualCents;
      updates.stripeAnnualPriceId = annual.id;
    }
  }

  // Keep the Product's display fields in sync (best-effort).
  if (
    stripe &&
    plan.stripeProductId &&
    (typeof input.name === "string" || input.description !== undefined)
  ) {
    await stripe.products
      .update(plan.stripeProductId, {
        ...(typeof input.name === "string" ? { name: input.name } : {}),
        ...(input.description !== undefined
          ? { description: input.description ?? "" }
          : {}),
      })
      .catch((err) =>
        console.warn("[billing] failed to sync Stripe product", err),
      );
  }

  // Archiving deactivates the prices so no new checkout can use them.
  if (input.status === "archived" && stripe) {
    if (plan.stripePriceId) {
      await stripe.prices
        .update(plan.stripePriceId, { active: false })
        .catch((err) =>
          console.warn("[billing] failed to deactivate archived price", err),
        );
    }
    if (plan.stripeAnnualPriceId) {
      await stripe.prices
        .update(plan.stripeAnnualPriceId, { active: false })
        .catch((err) =>
          console.warn(
            "[billing] failed to deactivate archived annual price",
            err,
          ),
        );
    }
  }

  await ref.update(updates);

  // Gate edits apply to every sub-account on this plan; comped/unmanaged ones
  // are left alone.
  if (input.gates) {
    const subs = await getAdminDb()
      .collection("subAccounts")
      .where("billing.planId", "==", input.planId)
      .get();
    for (const doc of subs.docs) {
      if (doc.data().agencyId !== input.agencyId) continue;
      const status = doc.data().billing?.status as
        | SubAccountBillingStatus
        | undefined;
      // Pending clients get gates at activation.
      if (status === "active" || status === "past_due") {
        await applyFeatureGates(doc.id, input.gates).catch((err) =>
          console.warn(
            `[billing] gate re-apply failed for sub-account ${doc.id}`,
            err,
          ),
        );
      }
    }
  }

  const updated = await ref.get();
  return serializePlan(ref.id, updated.data() ?? {});
}

async function getPlanOrThrow(
  agencyId: string,
  planId: string,
): Promise<BillingPlanDoc> {
  const snap = await plansCollection(agencyId).doc(planId).get();
  if (!snap.exists) throw new BillingError("Plan not found", 404);
  return { ...(snap.data() as BillingPlanDoc), id: snap.id };
}

// Assignment / comp / checkout links

async function getSubInAgencyOrThrow(agencyId: string, subAccountId: string) {
  const ref = getAdminDb().doc(`subAccounts/${subAccountId}`);
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.agencyId !== agencyId) {
    throw new BillingError("Sub-account not found", 404);
  }
  return { ref, data: snap.data() as Record<string, unknown> };
}

function readBilling(
  data: Record<string, unknown>,
): SubAccountBilling | null {
  return (data.billing as SubAccountBilling | null | undefined) ?? null;
}

/** Plan's standard price, or a one-off special price minted for this sub-account. */
async function resolveStripePrice(
  plan: BillingPlanDoc,
  subAccountId: string,
  specialPriceCents: number | null,
  interval: BillingInterval,
): Promise<string> {
  if (!plan.stripeProductId) {
    throw new BillingError(
      "This plan has no Stripe product — recreate it with Stripe configured.",
      500,
    );
  }
  const basePriceId =
    interval === "year" ? plan.stripeAnnualPriceId : plan.stripePriceId;
  if (interval === "year" && !basePriceId) {
    throw new BillingError(
      "This plan has no annual price — add one on the plan, or assign it monthly.",
    );
  }
  if (!basePriceId) {
    throw new BillingError(
      "This plan has no Stripe price — recreate it with Stripe configured.",
      500,
    );
  }
  if (specialPriceCents === null) return basePriceId;
  // Same interval so the cadence matches.
  const stripe = getStripeServer();
  const price = await stripe.prices.create({
    product: plan.stripeProductId,
    unit_amount: specialPriceCents,
    currency: plan.currency,
    recurring: { interval },
    metadata: {
      planId: plan.id,
      specialForSubAccountId: subAccountId,
      interval,
    },
  });
  return price.id;
}

export interface AssignPlanResult {
  status: SubAccountBillingStatus;
  /** Only when the sub-account still needs to pay. */
  checkoutUrl: string | null;
}

/**
 * Assign or switch a plan. Without a live subscription, billing goes pending
 * with a fresh checkout link and gates apply at activation. With one
 * (active/past_due), the single item moves to the new price (prorated) and the
 * gates apply now.
 */
export async function assignPlanToSubAccount(input: {
  agencyId: string;
  subAccountId: string;
  planId: string;
  specialPriceCents: number | null;
  /** Defaults to monthly. */
  interval?: BillingInterval;
}): Promise<AssignPlanResult> {
  if (!billingStripeIsConfigured()) {
    throw new BillingError(
      "Stripe isn't configured on this deployment. Set STRIPE_SECRET_KEY first.",
      503,
    );
  }
  const interval: BillingInterval = input.interval === "year" ? "year" : "month";
  const plan = await getPlanOrThrow(input.agencyId, input.planId);
  if (plan.status !== "active") {
    throw new BillingError("This plan is archived — unarchive it or pick another.");
  }
  if (interval === "year" && plan.priceAnnualCents == null) {
    throw new BillingError(
      "This plan doesn't offer annual billing — add an annual price or assign it monthly.",
    );
  }
  if (input.specialPriceCents !== null) {
    if (
      !Number.isInteger(input.specialPriceCents) ||
      input.specialPriceCents < MIN_PRICE_CENTS ||
      input.specialPriceCents > MAX_PRICE_CENTS
    ) {
      throw new BillingError("specialPriceCents is out of range.");
    }
  }

  const { ref, data } = await getSubInAgencyOrThrow(
    input.agencyId,
    input.subAccountId,
  );
  const billing = readBilling(data);
  const basePriceCents =
    interval === "year"
      ? (plan.priceAnnualCents as number)
      : plan.priceMonthlyCents;
  const priceCents = input.specialPriceCents ?? basePriceCents;
  const stripePriceId = await resolveStripePrice(
    plan,
    input.subAccountId,
    input.specialPriceCents,
    interval,
  );

  const hasLiveSubscription =
    !!billing?.stripeSubscriptionId &&
    (billing.status === "active" || billing.status === "past_due");

  if (hasLiveSubscription) {
    const stripe = getStripeServer();
    const sub = await stripe.subscriptions.retrieve(
      billing.stripeSubscriptionId as string,
    );
    const item = sub.items.data[0];
    if (!item) {
      throw new BillingError(
        "The Stripe subscription has no items — resolve it in the Stripe dashboard.",
        500,
      );
    }
    await stripe.subscriptions.update(sub.id, {
      items: [{ id: item.id, price: stripePriceId }],
      proration_behavior: "create_prorations",
      metadata: {
        kind: SUB_ACCOUNT_PLAN_KIND,
        agencyId: input.agencyId,
        subAccountId: input.subAccountId,
        planId: plan.id,
      },
    });

    await ref.update({
      "billing.planId": plan.id,
      "billing.planName": plan.name,
      "billing.priceCents": priceCents,
      "billing.billingInterval": interval,
      "billing.currency": plan.currency,
      "billing.specialPriceCents": input.specialPriceCents,
      "billing.stripePriceId": stripePriceId,
      "billing.updatedAt": FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    await applyFeatureGates(input.subAccountId, plan.gates);

    recordBillingEvent({
      agencyId: input.agencyId,
      subAccountId: input.subAccountId,
      event: "plan.switched",
      detail: { planId: plan.id, planName: plan.name, priceCents },
    });
    void emitWebhookEvent({
      subAccountId: input.subAccountId,
      agencyId: input.agencyId,
      mode: "live",
      type: "billing.plan.assigned",
      payload: {
        subAccountId: input.subAccountId,
        planId: plan.id,
        planName: plan.name,
        priceCents,
        currency: plan.currency,
        status: billing?.status ?? "active",
      },
    });
    return { status: billing?.status ?? "active", checkoutUrl: null };
  }

  // Fresh assignment (or after a cancel): pending + link.
  const { token, hash } = issueCheckoutToken(input.subAccountId);
  const next: Record<string, unknown> = {
    billing: {
      status: "pending" satisfies SubAccountBillingStatus,
      planId: plan.id,
      planName: plan.name,
      priceCents,
      billingInterval: interval,
      currency: plan.currency,
      specialPriceCents: input.specialPriceCents,
      stripePriceId,
      stripeCustomerId: billing?.stripeCustomerId ?? null,
      stripeSubscriptionId: null,
      checkoutTokenHash: hash,
      graceUntil: null,
      assignedAt: FieldValue.serverTimestamp(),
      activatedAt: billing?.activatedAt ?? null,
      updatedAt: FieldValue.serverTimestamp(),
    },
    updatedAt: FieldValue.serverTimestamp(),
  };
  await ref.update(next);

  recordBillingEvent({
    agencyId: input.agencyId,
    subAccountId: input.subAccountId,
    event: "plan.assigned",
    detail: {
      planId: plan.id,
      planName: plan.name,
      priceCents,
      specialPriceCents: input.specialPriceCents,
    },
  });
  void emitWebhookEvent({
    subAccountId: input.subAccountId,
    agencyId: input.agencyId,
    mode: "live",
    type: "billing.plan.assigned",
    payload: {
      subAccountId: input.subAccountId,
      planId: plan.id,
      planName: plan.name,
      priceCents,
      currency: plan.currency,
      status: "pending",
    },
  });

  return { status: "pending", checkoutUrl: buildCheckoutUrl(token) };
}

/** Comp a sub-account: cancel any live subscription now and hand gates back to
 *  manual control. Data and gates stay as they are. */
export async function compSubAccount(input: {
  agencyId: string;
  subAccountId: string;
}): Promise<void> {
  const { ref, data } = await getSubInAgencyOrThrow(
    input.agencyId,
    input.subAccountId,
  );
  const billing = readBilling(data);

  if (billing?.stripeSubscriptionId && billingStripeIsConfigured()) {
    await getStripeServer()
      .subscriptions.cancel(billing.stripeSubscriptionId)
      .catch((err) => {
        // A canceled or missing subscription shouldn't block the comp.
        console.warn("[billing] cancel-on-comp failed (continuing)", err);
      });
  }

  await ref.update({
    billing: {
      status: "comped" satisfies SubAccountBillingStatus,
      planId: null,
      planName: null,
      priceCents: null,
      billingInterval: null,
      currency: null,
      specialPriceCents: null,
      stripePriceId: null,
      stripeCustomerId: billing?.stripeCustomerId ?? null,
      stripeSubscriptionId: null,
      checkoutTokenHash: null,
      graceUntil: null,
      assignedAt: billing?.assignedAt ?? null,
      activatedAt: billing?.activatedAt ?? null,
      updatedAt: FieldValue.serverTimestamp(),
    },
    updatedAt: FieldValue.serverTimestamp(),
  });

  recordBillingEvent({
    agencyId: input.agencyId,
    subAccountId: input.subAccountId,
    event: "comped",
    detail: {
      previousStatus: billing?.status ?? null,
      canceledSubscription: billing?.stripeSubscriptionId ?? null,
    },
  });
}

/** Rotates the checkout token. */
export async function mintCheckoutLink(input: {
  agencyId: string;
  subAccountId: string;
}): Promise<string> {
  const { ref, data } = await getSubInAgencyOrThrow(
    input.agencyId,
    input.subAccountId,
  );
  const billing = readBilling(data);
  if (!billing || billing.status === "comped" || !billing.planId) {
    throw new BillingError("Assign a plan before generating a checkout link.");
  }
  if (billing.status === "active") {
    throw new BillingError(
      "This client already has an active subscription — use the billing portal for card changes.",
    );
  }
  const { token, hash } = issueCheckoutToken(input.subAccountId);
  await ref.update({
    "billing.checkoutTokenHash": hash,
    "billing.updatedAt": FieldValue.serverTimestamp(),
  });
  return buildCheckoutUrl(token);
}

// Checkout session (/pay/[token] and the in-app activation screen)

export async function createSubAccountCheckoutSession(input: {
  subAccountId: string;
  successUrl: string;
  cancelUrl: string;
}): Promise<{ url: string }> {
  if (!billingStripeIsConfigured()) {
    throw new BillingError("Stripe isn't configured on this deployment.", 503);
  }
  const db = getAdminDb();
  const ref = db.doc(`subAccounts/${input.subAccountId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new BillingError("Sub-account not found", 404);
  const data = snap.data() as Record<string, unknown>;
  const billing = readBilling(data);

  if (!billing || !billing.planId || !billing.stripePriceId) {
    throw new BillingError("No plan is assigned to this workspace.", 409);
  }
  if (billing.status === "active") {
    throw new BillingError("This subscription is already active.", 409);
  }
  if (billing.status === "comped") {
    throw new BillingError("This workspace isn't billed through checkout.", 409);
  }

  const stripe = getStripeServer();
  const agencyId = String(data.agencyId ?? "");

  // One Stripe customer per sub-account, reused so payment history stays together.
  let customerId = billing.stripeCustomerId;
  if (!customerId) {
    const contact = data.accountContact as {
      name?: string | null;
      email?: string | null;
    } | null;
    const customer = await stripe.customers.create({
      name: String(data.name ?? "Sub-account"),
      ...(contact?.email ? { email: contact.email } : {}),
      metadata: {
        kind: SUB_ACCOUNT_PLAN_KIND,
        agencyId,
        subAccountId: input.subAccountId,
      },
    });
    customerId = customer.id;
    await ref.update({
      "billing.stripeCustomerId": customerId,
      "billing.updatedAt": FieldValue.serverTimestamp(),
    });
  }

  const metadata = {
    kind: SUB_ACCOUNT_PLAN_KIND,
    agencyId,
    subAccountId: input.subAccountId,
    planId: billing.planId,
  };
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: billing.stripePriceId, quantity: 1 }],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    metadata,
    subscription_data: { metadata },
  });
  if (!session.url) {
    throw new BillingError("Stripe did not return a checkout URL.", 502);
  }
  return { url: session.url };
}

// Stripe webhook handlers (routed from lib/stripe/webhooks.ts)

/** checkout.session.completed with metadata.kind === "subAccountPlan". */
export async function handleSubAccountPlanCheckoutCompleted(
  session: Stripe.Checkout.Session,
): Promise<void> {
  const subAccountId = session.metadata?.subAccountId;
  const planId = session.metadata?.planId;
  if (!subAccountId || !planId) {
    console.error(
      "[billing] subAccountPlan checkout completed without subAccountId/planId metadata",
    );
    return;
  }

  const db = getAdminDb();
  const ref = db.doc(`subAccounts/${subAccountId}`);
  const snap = await ref.get();
  if (!snap.exists) {
    console.error(`[billing] checkout completed for missing sub-account ${subAccountId}`);
    return;
  }
  const data = snap.data() as Record<string, unknown>;
  const agencyId = String(data.agencyId ?? "");
  const billing = readBilling(data);

  await ref.update({
    "billing.status": "active" satisfies SubAccountBillingStatus,
    "billing.stripeCustomerId":
      (session.customer as string | null) ?? billing?.stripeCustomerId ?? null,
    "billing.stripeSubscriptionId":
      (session.subscription as string | null) ??
      billing?.stripeSubscriptionId ??
      null,
    "billing.checkoutTokenHash": null,
    "billing.graceUntil": null,
    "billing.activatedAt": FieldValue.serverTimestamp(),
    "billing.updatedAt": FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  // Re-read the plan so gate edits made before payment still apply.
  try {
    const planSnap = await db
      .doc(`agencies/${agencyId}/plans/${planId}`)
      .get();
    const gates = planSnap.exists
      ? normalizePlanGates(planSnap.data()?.gates)
      : null;
    if (gates) {
      const { skippedMetaGates } = await applyFeatureGates(subAccountId, gates);
      if (skippedMetaGates.length > 0) {
        console.warn(
          `[billing] plan ${planId} wants Meta gates but the deployment lacks META_APP_ID/SECRET — left off for ${subAccountId}`,
        );
      }
    }
  } catch (err) {
    // A gate write blip mustn't fail activation; the agency can re-apply.
    console.error("[billing] gate application on activation failed", err);
  }

  recordBillingEvent({
    agencyId,
    subAccountId,
    event: "activated",
    detail: {
      planId,
      planName: billing?.planName ?? null,
      priceCents: billing?.priceCents ?? null,
      stripeSubscriptionId: (session.subscription as string | null) ?? null,
    },
  });
  void emitWebhookEvent({
    subAccountId,
    agencyId,
    mode: "live",
    type: "billing.activated",
    payload: {
      subAccountId,
      planId,
      planName: billing?.planName ?? null,
      priceCents: billing?.priceCents ?? null,
      currency: billing?.currency ?? null,
    },
  });
}

/** subscription.updated/.deleted for plan subscriptions: maps status and
 *  stamps/clears the dunning grace window. */
export async function handleSubAccountSubscriptionEvent(
  subscription: Stripe.Subscription,
  opts: { deleted: boolean },
): Promise<void> {
  const db = getAdminDb();

  // Metadata normally has the id; fall back to a lookup in case someone stripped
  // it in the Stripe dashboard.
  let subAccountId: string | null =
    subscription.metadata?.subAccountId ?? null;
  if (!subAccountId) {
    const match = await db
      .collection("subAccounts")
      .where("billing.stripeSubscriptionId", "==", subscription.id)
      .limit(1)
      .get();
    subAccountId = match.empty ? null : match.docs[0].id;
  }
  if (!subAccountId) {
    console.error(
      `[billing] no sub-account found for subscription ${subscription.id}`,
    );
    return;
  }

  const ref = db.doc(`subAccounts/${subAccountId}`);
  const snap = await ref.get();
  if (!snap.exists) return;
  const data = snap.data() as Record<string, unknown>;
  const agencyId = String(data.agencyId ?? "");
  const billing = readBilling(data);
  if (!billing || billing.status === "comped") return;
  // Ignore a superseded subscription (e.g. the old one's cancel arriving after a
  // re-checkout).
  if (
    billing.stripeSubscriptionId &&
    billing.stripeSubscriptionId !== subscription.id
  ) {
    return;
  }

  // While pending, only "active" matters. Half-finished checkouts emit
  // incomplete/incomplete_expired noise that mustn't push a never-paid workspace
  // into dunning or cancellation.
  if (
    billing.status === "pending" &&
    subscription.status !== "active" &&
    subscription.status !== "trialing"
  ) {
    return;
  }

  let nextStatus: SubAccountBillingStatus;
  if (opts.deleted) {
    nextStatus = "canceled";
  } else {
    switch (subscription.status) {
      case "active":
      case "trialing":
        nextStatus = "active";
        break;
      case "past_due":
      case "unpaid":
      case "incomplete":
        nextStatus = "past_due";
        break;
      case "canceled":
      case "incomplete_expired":
        nextStatus = "canceled";
        break;
      default:
        nextStatus = billing.status;
    }
  }

  const updates: Record<string, unknown> = {
    "billing.stripeSubscriptionId": opts.deleted ? null : subscription.id,
    "billing.updatedAt": FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (nextStatus !== billing.status) {
    updates["billing.status"] = nextStatus;
  }
  if (nextStatus === "past_due") {
    // Once per dunning episode; Stripe retries must not keep pushing the paywall out.
    const alreadyStamped = billing.status === "past_due" && billing.graceUntil;
    if (!alreadyStamped) {
      updates["billing.graceUntil"] = Timestamp.fromMillis(
        Date.now() + BILLING_GRACE_DAYS * 24 * 60 * 60 * 1000,
      );
    }
  }
  if (nextStatus === "active") {
    updates["billing.graceUntil"] = null;
  }

  await ref.update(updates);

  if (nextStatus !== billing.status) {
    recordBillingEvent({
      agencyId,
      subAccountId,
      event: "status.changed",
      detail: {
        previousStatus: billing.status,
        status: nextStatus,
        stripeStatus: subscription.status,
        deleted: opts.deleted,
      },
    });
    const eventType =
      nextStatus === "past_due"
        ? "billing.past_due"
        : nextStatus === "canceled"
          ? "billing.canceled"
          : nextStatus === "active"
            ? "billing.activated"
            : null;
    if (eventType) {
      void emitWebhookEvent({
        subAccountId,
        agencyId,
        mode: "live",
        type: eventType,
        payload: {
          subAccountId,
          planId: billing.planId,
          planName: billing.planName,
          previousStatus: billing.status,
          status: nextStatus,
        },
      });
    }
  }
}

// One-time charges (agency to client, e.g. a web design fee)

function chargesCollection() {
  return getAdminDb().collection("billingCharges");
}

function serializeCharge(
  id: string,
  data: FirebaseFirestore.DocumentData,
): BillingChargeResponse {
  return {
    id,
    subAccountId: String(data.subAccountId ?? ""),
    description: String(data.description ?? ""),
    amountCents: Number(data.amountCents ?? 0),
    currency: String(data.currency ?? "usd"),
    status:
      data.status === "paid" || data.status === "canceled"
        ? (data.status as BillingChargeStatus)
        : "pending",
    createdAt: tsToIso(data.createdAt),
    paidAt: tsToIso(data.paidAt),
    kind: data.kind === "usage" ? "usage" : "manual",
    usageMonth: typeof data.usageMonth === "string" ? data.usageMonth : null,
    lineItems: Array.isArray(data.lineItems) ? (data.lineItems as UsageChargeLine[]) : [],
    dueAt: tsToIso(data.dueAt),
  };
}

export function validateChargeInput(
  description: unknown,
  amountCents: unknown,
  currency: unknown,
): { description: string; amountCents: number; currency: string } {
  const desc = typeof description === "string" ? description.trim() : "";
  if (!desc || desc.length > 120) {
    throw new BillingError("description is required (1–120 characters).");
  }
  if (
    typeof amountCents !== "number" ||
    !Number.isInteger(amountCents) ||
    amountCents < MIN_PRICE_CENTS ||
    amountCents > MAX_PRICE_CENTS
  ) {
    throw new BillingError(
      `amountCents must be an integer between ${MIN_PRICE_CENTS} and ${MAX_PRICE_CENTS}.`,
    );
  }
  const cur = typeof currency === "string" ? currency.trim().toLowerCase() : "";
  if (!/^[a-z]{3}$/.test(cur)) {
    throw new BillingError(
      'currency must be a 3-letter ISO code (e.g. "usd", "aud").',
    );
  }
  return { description: desc, amountCents, currency: cur };
}

/** Create a one-time charge + its /pay/charge link. Works for any sub-account in
 *  the agency, comped ones included. */
export async function createOneTimeCharge(input: {
  agencyId: string;
  subAccountId: string;
  createdByUid: string;
  description: string;
  amountCents: number;
  currency: string;
}): Promise<{ charge: BillingChargeResponse; checkoutUrl: string }> {
  if (!billingStripeIsConfigured()) {
    throw new BillingError(
      "Stripe isn't configured on this deployment. Set STRIPE_SECRET_KEY first.",
      503,
    );
  }
  // Re-anchor to the caller's agency, as with plans.
  await getSubInAgencyOrThrow(input.agencyId, input.subAccountId);

  const ref = chargesCollection().doc();
  const { token, hash } = issueChargeToken(ref.id);
  const doc: Omit<BillingChargeDoc, "id" | "createdAt" | "paidAt" | "updatedAt"> = {
    agencyId: input.agencyId,
    subAccountId: input.subAccountId,
    description: input.description,
    amountCents: input.amountCents,
    currency: input.currency,
    status: "pending",
    tokenHash: hash,
    stripeCheckoutSessionId: null,
    stripePaymentIntentId: null,
    createdByUid: input.createdByUid,
  };
  await ref.set({
    ...doc,
    id: ref.id,
    createdAt: FieldValue.serverTimestamp(),
    paidAt: null,
    updatedAt: FieldValue.serverTimestamp(),
  });

  recordBillingEvent({
    agencyId: input.agencyId,
    subAccountId: input.subAccountId,
    event: "charge.created",
    detail: {
      chargeId: ref.id,
      description: input.description,
      amountCents: input.amountCents,
      currency: input.currency,
    },
  });

  const snap = await ref.get();
  return {
    charge: serializeCharge(ref.id, snap.data() ?? {}),
    checkoutUrl: buildChargeCheckoutUrl(token),
  };
}

/** Point `usageOverdue` at the oldest overdue usage charge, or clear it. Never throws. */
export async function refreshUsageOverdue(
  subAccountId: string,
  now: Date = new Date(),
): Promise<void> {
  try {
    const db = getAdminDb();
    const subRef = db.doc(`subAccounts/${subAccountId}`);
    const today = now.toISOString().slice(0, 10);
    // One transaction, so a payment landing mid-refresh can't be overwritten
    // by a stale "still overdue" read.
    await db.runTransaction(async (tx) => {
      const [snap, subSnap] = await Promise.all([
        tx.get(
          chargesCollection()
            .where("subAccountId", "==", subAccountId)
            .where("kind", "==", "usage")
            .where("status", "==", "pending"),
        ),
        tx.get(subRef),
      ]);
      if (!subSnap.exists) return;
      // Overdue once the due day (UTC) has passed; "due today" isn't overdue yet.
      const oldest = snap.docs
        .map((d) => {
          const due = d.data().dueAt;
          return { d, dueMs: due instanceof Timestamp ? due.toMillis() : null };
        })
        .filter(
          (x): x is { d: typeof x.d; dueMs: number } =>
            x.dueMs !== null && new Date(x.dueMs).toISOString().slice(0, 10) < today,
        )
        .sort((a, b) => a.dueMs - b.dueMs)[0];
      const current = subSnap.data()?.usageOverdue as { chargeId?: string } | null | undefined;
      if (!oldest) {
        if (current) tx.update(subRef, { usageOverdue: null });
        return;
      }
      if (current?.chargeId === oldest.d.id) return;
      const c = oldest.d.data();
      tx.update(subRef, {
        usageOverdue: {
          chargeId: oldest.d.id,
          since: Timestamp.fromMillis(oldest.dueMs),
          amountCents: Number(c.amountCents ?? 0),
          currency: String(c.currency ?? "usd"),
          usageMonth: typeof c.usageMonth === "string" ? c.usageMonth : null,
        },
      });
    });
  } catch (err) {
    console.warn(`[billing] usage overdue refresh failed sa=${subAccountId}`, err);
  }
}

/** Deterministic so a re-run of the month close can never mint a second charge. */
export function usageChargeId(subAccountId: string, month: string): string {
  return `usage_${subAccountId}_${month}`;
}

/** Create the month's usage charge at most once; a repeat returns `created: false`. */
export async function createUsageCharge(input: {
  agencyId: string;
  subAccountId: string;
  month: string;
  description: string;
  amountCents: number;
  currency: string;
  lineItems: UsageChargeLine[];
  dueAt: Date;
}): Promise<{ created: boolean; chargeId: string; checkoutUrl: string | null }> {
  if (!billingStripeIsConfigured()) {
    throw new BillingError(
      "Stripe isn't configured on this deployment. Set STRIPE_SECRET_KEY first.",
      503,
    );
  }
  const chargeId = usageChargeId(input.subAccountId, input.month);
  const ref = chargesCollection().doc(chargeId);
  const { token, hash } = issueChargeToken(chargeId);
  const checkoutUrl = buildChargeCheckoutUrl(token);
  if (!checkoutUrl) {
    throw new BillingError("NEXT_PUBLIC_APP_URL isn't configured, so no pay link can be built.", 503);
  }
  try {
    await ref.create({
      id: chargeId,
      agencyId: input.agencyId,
      subAccountId: input.subAccountId,
      description: input.description,
      amountCents: input.amountCents,
      currency: input.currency,
      status: "pending" satisfies BillingChargeStatus,
      tokenHash: hash,
      stripeCheckoutSessionId: null,
      stripePaymentIntentId: null,
      createdByUid: "system:usage-close",
      kind: "usage",
      usageMonth: input.month,
      lineItems: input.lineItems,
      dueAt: Timestamp.fromDate(input.dueAt),
      payUrl: checkoutUrl,
      remindedAt: {},
      emailedTo: null,
      createdAt: FieldValue.serverTimestamp(),
      paidAt: null,
      updatedAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    // gRPC ALREADY_EXISTS: an earlier run already minted it.
    if ((err as { code?: number }).code === 6) {
      return { created: false, chargeId, checkoutUrl: null };
    }
    throw err;
  }
  recordBillingEvent({
    agencyId: input.agencyId,
    subAccountId: input.subAccountId,
    event: "charge.created",
    detail: {
      chargeId,
      kind: "usage",
      usageMonth: input.month,
      amountCents: input.amountCents,
      currency: input.currency,
    },
  });
  return { created: true, chargeId, checkoutUrl };
}

export async function listChargesForSubAccount(
  agencyId: string,
  subAccountId: string,
): Promise<BillingChargeResponse[]> {
  await getSubInAgencyOrThrow(agencyId, subAccountId);
  const snap = await chargesCollection()
    .where("subAccountId", "==", subAccountId)
    .limit(100)
    .get();
  return snap.docs
    .filter((d) => d.data().agencyId === agencyId)
    .map((d) => serializeCharge(d.id, d.data()))
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

/** Every charge in the agency, newest first; single-field query, no index needed. */
export async function listChargesForAgency(
  agencyId: string,
): Promise<BillingChargeResponse[]> {
  const snap = await chargesCollection()
    .where("agencyId", "==", agencyId)
    .limit(1000)
    .get();
  return snap.docs
    .map((d) => serializeCharge(d.id, d.data()))
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

async function getChargeInAgencyOrThrow(
  agencyId: string,
  chargeId: string,
): Promise<{ ref: FirebaseFirestore.DocumentReference; data: BillingChargeDoc }> {
  const ref = chargesCollection().doc(chargeId);
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.agencyId !== agencyId) {
    throw new BillingError("Charge not found", 404);
  }
  return { ref, data: { ...(snap.data() as BillingChargeDoc), id: snap.id } };
}

/** Rotates the charge's token. */
export async function mintChargeCheckoutLink(input: {
  agencyId: string;
  chargeId: string;
}): Promise<string> {
  const { ref, data } = await getChargeInAgencyOrThrow(
    input.agencyId,
    input.chargeId,
  );
  if (data.status !== "pending") {
    throw new BillingError(
      data.status === "paid"
        ? "This charge is already paid."
        : "This charge was canceled — create a new one instead.",
    );
  }
  const { token, hash } = issueChargeToken(input.chargeId);
  const url = buildChargeCheckoutUrl(token);
  await ref.update({
    tokenHash: hash,
    // Reminders reuse the stored link, so keep it pointing at the live token.
    ...(data.kind === "usage" ? { payUrl: url || null } : {}),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return url;
}

/** Kills the link. Paid charges can't be canceled here. */
export async function cancelOneTimeCharge(input: {
  agencyId: string;
  chargeId: string;
}): Promise<void> {
  const { ref, data } = await getChargeInAgencyOrThrow(
    input.agencyId,
    input.chargeId,
  );
  if (data.status === "paid") {
    throw new BillingError(
      "This charge is already paid — refund it from the Stripe dashboard instead.",
    );
  }
  if (data.status === "canceled") return;
  await ref.update({
    status: "canceled" satisfies BillingChargeStatus,
    tokenHash: null,
    payUrl: null,
    updatedAt: FieldValue.serverTimestamp(),
  });
  // A checkout tab left open could otherwise still take payment. Best-effort.
  if (data.stripeCheckoutSessionId && billingStripeIsConfigured()) {
    try {
      const stripe = getStripeServer();
      const open = await stripe.checkout.sessions.retrieve(data.stripeCheckoutSessionId);
      if (open.status === "open") await stripe.checkout.sessions.expire(open.id);
    } catch (err) {
      console.warn(`[billing] couldn't expire checkout for canceled charge ${input.chargeId}`, err);
    }
  }
  recordBillingEvent({
    agencyId: input.agencyId,
    subAccountId: data.subAccountId,
    event: "charge.canceled",
    detail: { chargeId: input.chargeId, description: data.description },
  });
  // Waiving a usage charge lifts its banner or paywall.
  if (data.kind === "usage") await refreshUsageOverdue(data.subAccountId);
}

/**
 * Checkout for a verified /pay/charge token: mode "payment" with ad-hoc
 * price_data (no Product/Price created). Reuses the sub-account's Stripe customer
 * so it lands on the same record as their subscription.
 */
export async function createChargeCheckoutSession(input: {
  chargeId: string;
  successUrl: string;
  cancelUrl: string;
}): Promise<{ url: string }> {
  if (!billingStripeIsConfigured()) {
    throw new BillingError("Stripe isn't configured on this deployment.", 503);
  }
  const ref = chargesCollection().doc(input.chargeId);
  const snap = await ref.get();
  if (!snap.exists) throw new BillingError("Charge not found", 404);
  const charge = snap.data() as BillingChargeDoc;
  if (charge.status === "paid") {
    throw new BillingError("This charge is already paid — nothing more to do.");
  }
  if (charge.status === "canceled") {
    throw new BillingError(
      "This charge was canceled. Ask your provider for a new payment link.",
    );
  }

  const stripe = getStripeServer();
  const priorSessionId = charge.stripeCheckoutSessionId ?? null;
  // One open session per charge: the emailed link and the in-app Pay button
  // would otherwise each take payment.
  if (charge.stripeCheckoutSessionId) {
    const prev = await stripe.checkout.sessions
      .retrieve(charge.stripeCheckoutSessionId)
      .catch(() => null);
    // Paid but the webhook hasn't landed yet: a new session would charge twice.
    if (prev?.status === "complete") {
      throw new BillingError(
        "This payment is already being processed. It can take a minute to show.",
        409,
      );
    }
    if (prev?.status === "open" && prev.url) {
      if (prev.success_url === input.successUrl) return { url: prev.url };
      // Opened from the other pay path: replace it so the payer returns to the
      // right page, and so only one session stays payable.
      try {
        await stripe.checkout.sessions.expire(prev.id);
      } catch {
        throw new BillingError("A payment for this charge is in progress. Please try again.", 409);
      }
    }
  }

  const subSnap = await getAdminDb()
    .doc(`subAccounts/${charge.subAccountId}`)
    .get();
  const billing = subSnap.exists
    ? readBilling(subSnap.data() as Record<string, unknown>)
    : null;

  const metadata = {
    kind: SUB_ACCOUNT_CHARGE_KIND,
    agencyId: charge.agencyId,
    subAccountId: charge.subAccountId,
    chargeId: input.chargeId,
  };
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    ...(billing?.stripeCustomerId ? { customer: billing.stripeCustomerId } : {}),
    line_items: [
      {
        price_data: {
          currency: charge.currency,
          unit_amount: charge.amountCents,
          product_data: { name: charge.description },
        },
        quantity: 1,
      },
    ],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    metadata,
    payment_intent_data: { metadata },
  });
  if (!session.url) {
    throw new BillingError("Stripe did not return a checkout URL.", 502);
  }
  // Only attach the session if the charge is still payable; a waive that
  // landed while Stripe was creating it must not leave a live checkout.
  // A concurrent click that attached its own session first wins, so only one
  // session per charge can ever take payment.
  const outcome = await getAdminDb().runTransaction(async (tx) => {
    const fresh = (await tx.get(ref)).data();
    if (fresh?.status !== "pending") return { kind: "closed" as const };
    const current = (fresh.stripeCheckoutSessionId as string | null | undefined) ?? null;
    if (current !== priorSessionId) return { kind: "raced" as const, sessionId: current };
    tx.update(ref, {
      stripeCheckoutSessionId: session.id,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { kind: "attached" as const };
  });
  if (outcome.kind === "attached") return { url: session.url };
  await stripe.checkout.sessions.expire(session.id).catch(() => {});
  if (outcome.kind === "raced" && outcome.sessionId) {
    const winner = await stripe.checkout.sessions.retrieve(outcome.sessionId).catch(() => null);
    if (winner?.status === "open" && winner.url) return { url: winner.url };
  }
  throw new BillingError(
    outcome.kind === "closed"
      ? "This charge was waived or already paid."
      : "A payment for this charge was just started. Please try again.",
    409,
  );
}

/** checkout.session.completed with metadata.kind === "subAccountCharge". */
export async function handleSubAccountChargeCheckoutCompleted(
  session: Stripe.Checkout.Session,
): Promise<void> {
  const chargeId = session.metadata?.chargeId;
  if (!chargeId) {
    console.error(
      "[billing] subAccountCharge checkout completed without chargeId metadata",
    );
    return;
  }
  const ref = chargesCollection().doc(chargeId);
  const snap = await ref.get();
  if (!snap.exists) {
    console.error(`[billing] checkout completed for missing charge ${chargeId}`);
    return;
  }
  const charge = snap.data() as BillingChargeDoc;
  if (charge.status === "paid") {
    // Webhook retry: nothing to mark, but make sure no overdue flag is left behind.
    if (charge.kind === "usage") await refreshUsageOverdue(charge.subAccountId);
    return;
  }
  if (charge.status === "canceled") {
    // Money was taken anyway (a session that couldn't be expired); record it so
    // the agency can refund it from Stripe.
    console.warn(`[billing] canceled charge ${chargeId} was paid; refund it in Stripe if unwanted`);
  }

  await ref.update({
    status: "paid" satisfies BillingChargeStatus,
    tokenHash: null,
    payUrl: null,
    stripeCheckoutSessionId: session.id,
    stripePaymentIntentId:
      typeof session.payment_intent === "string" ? session.payment_intent : null,
    paidAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  if (charge.kind === "usage") await refreshUsageOverdue(charge.subAccountId);
  recordBillingEvent({
    agencyId: charge.agencyId,
    subAccountId: charge.subAccountId,
    event: "charge.paid",
    detail: {
      chargeId,
      description: charge.description,
      amountCents: charge.amountCents,
      currency: charge.currency,
    },
  });
  void emitWebhookEvent({
    subAccountId: charge.subAccountId,
    agencyId: charge.agencyId,
    mode: "live",
    type: "billing.charge.paid",
    payload: {
      chargeId,
      subAccountId: charge.subAccountId,
      description: charge.description,
      amountCents: charge.amountCents,
      currency: charge.currency,
    },
  });
}
