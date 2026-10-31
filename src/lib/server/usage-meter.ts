import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import type {
  AiMeter,
  FeatureFees,
  UsageCounter,
  UsageMonthDoc,
  UsageQuotas,
  UsageRates,
  UsageUnit,
} from "@/types/usage";
import {
  FEE_GATE_KEYS,
  FEE_GATE_LABELS,
  feeGateOn,
  type FeeGateKey,
} from "@/types/billing";
import { runAfterResponse } from "@/lib/server/after-response";
import { formatBillingPrice } from "@/lib/billing/status";

/**
 * Write/check path for the per-workspace usage ledger
 * (subAccounts/{id}/usage/{YYYY-MM}).
 *  - recordUsage is best-effort and swallows failures, so metering can never
 *    block a customer-facing send.
 *  - checkQuota fails open.
 *  - Rebilled only when both the agency and client switch are on; otherwise
 *    quotas are hard caps.
 *  - Voice quotas are set in minutes, compared in seconds.
 */

interface QuotaSubjectSubAccount extends Partial<Record<FeeGateKey, unknown>> {
  agencyId?: string;
  usageQuotas?: UsageQuotas | null;
  usageRates?: UsageRates | null;
  usageRebillingEnabled?: boolean;
  usageSpendCapCents?: number | null;
  featureFees?: FeatureFees | null;
  billing?: { planId?: string | null; currency?: string | null } | null;
  twilioConfig?: { enabled?: boolean } | null;
  name?: string;
}

const UNIT_META: Record<
  UsageUnit,
  { quotaKey: keyof UsageQuotas; label: string; plural: string; quotaFactor: number }
> = {
  emailsSent: { quotaKey: "emailsPerMonth", label: "email", plural: "emails", quotaFactor: 1 },
  smsSegments: {
    quotaKey: "smsSegmentsPerMonth",
    label: "SMS segment",
    plural: "SMS segments",
    quotaFactor: 1,
  },
  whatsappMessages: {
    quotaKey: "whatsappPerMonth",
    label: "WhatsApp message",
    plural: "WhatsApp messages",
    quotaFactor: 1,
  },
  aiTokens: { quotaKey: "aiTokensPerMonth", label: "AI token", plural: "AI tokens", quotaFactor: 1 },
  aiReplies: { quotaKey: "aiRepliesPerMonth", label: "AI reply", plural: "AI replies", quotaFactor: 1 },
  // Configured in minutes, ledger counts seconds.
  voiceSeconds: {
    quotaKey: "voiceMinutesPerMonth",
    label: "voice minute",
    plural: "voice minutes",
    quotaFactor: 60,
  },
  webVoiceSeconds: {
    quotaKey: "webVoiceMinutesPerMonth",
    label: "web voice minute",
    plural: "web voice minutes",
    quotaFactor: 60,
  },
};

/** Units that can carry a rate and the counter billed. SMS bills only the shared sender. */
const PRICED: Partial<
  Record<UsageUnit, { rateKey: keyof UsageRates; billable: UsageCounter; perSeconds?: number }>
> = {
  emailsSent: { rateKey: "emailCents", billable: "emailsSent" },
  smsSegments: { rateKey: "smsSegmentCents", billable: "smsSegmentsShared" },
  aiReplies: { rateKey: "aiReplyCents", billable: "aiReplies" },
  voiceSeconds: { rateKey: "voiceMinuteCents", billable: "voiceSeconds", perSeconds: 60 },
  webVoiceSeconds: {
    rateKey: "webVoiceMinuteCents",
    billable: "webVoiceSeconds",
    perSeconds: 60,
  },
};

/** Months are UTC everywhere (servers run UTC; the close cron and emails agree). */
export function usageMonthKey(d: Date = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthRef(subAccountId: string, month: string) {
  return getAdminDb().doc(`subAccounts/${subAccountId}/usage/${month}`);
}

// Resolution: workspace override, then plan, then none

interface PlanBilling {
  quotas: UsageQuotas | null;
  rates: UsageRates | null;
  spendCapCents: number | null;
  featureFees: FeatureFees | null;
}

/** 5-minute in-memory caches keep per-send overhead near zero. */
const CACHE_TTL_MS = 5 * 60 * 1000;
const _planCache = new Map<string, PlanBilling & { at: number }>();
const _subCache = new Map<
  string,
  { sub: QuotaSubjectSubAccount | null; at: number }
>();
const _agencyRebillingCache = new Map<string, { on: boolean; at: number }>();

/** Call after writing billing settings so this instance picks them up now. */
export function invalidateUsageBillingCache(): void {
  _planCache.clear();
  _subCache.clear();
  _agencyRebillingCache.clear();
}

async function loadSubAccount(
  subAccountId: string,
): Promise<QuotaSubjectSubAccount | null> {
  const cached = _subCache.get(subAccountId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.sub;
  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  const sub = snap.exists ? (snap.data() as QuotaSubjectSubAccount) : null;
  _subCache.set(subAccountId, { sub, at: Date.now() });
  return sub;
}

async function loadPlanBilling(
  agencyId: string,
  planId: string,
): Promise<PlanBilling> {
  const key = `${agencyId}/${planId}`;
  const cached = _planCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached;
  const data = (
    await getAdminDb().doc(`agencies/${agencyId}/plans/${planId}`).get()
  ).data();
  const plan: PlanBilling = {
    quotas: (data?.quotas as UsageQuotas | undefined) ?? null,
    rates: (data?.rates as UsageRates | undefined) ?? null,
    spendCapCents: positiveInt(data?.spendCapCents),
    featureFees: (data?.featureFees as FeatureFees | undefined) ?? null,
  };
  _planCache.set(key, { ...plan, at: Date.now() });
  return plan;
}

async function agencyRebillingOn(agencyId: string): Promise<boolean> {
  const cached = _agencyRebillingCache.get(agencyId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.on;
  const snap = await getAdminDb().doc(`agencies/${agencyId}`).get();
  const on = snap.data()?.usageRebillingEnabled === true;
  _agencyRebillingCache.set(agencyId, { on, at: Date.now() });
  return on;
}

function positiveInt(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
}

export interface EffectiveBilling {
  quotas: UsageQuotas | null;
  rates: UsageRates | null;
  spendCapCents: number | null;
  featureFees: FeatureFees | null;
  /** Agency switch AND client switch. */
  rebilling: boolean;
}

/** Everything the meter needs for one workspace. Pass the sub doc to skip a read. */
export async function getEffectiveBilling(
  subAccountId: string,
  subAccount?: QuotaSubjectSubAccount | null,
): Promise<EffectiveBilling> {
  const sub = subAccount ?? (await loadSubAccount(subAccountId));
  if (!sub) {
    return { quotas: null, rates: null, spendCapCents: null, featureFees: null, rebilling: false };
  }
  const planId = sub.billing?.planId;
  const plan: PlanBilling =
    planId && sub.agencyId
      ? await loadPlanBilling(sub.agencyId, planId)
      : { quotas: null, rates: null, spendCapCents: null, featureFees: null };
  const rebilling =
    sub.usageRebillingEnabled === true && !!sub.agencyId
      ? await agencyRebillingOn(sub.agencyId)
      : false;
  // A workspace ceiling of 0 means "no ceiling for this client" over the plan's.
  const subCap = sub.usageSpendCapCents;
  const spendCapCents =
    typeof subCap === "number" && Number.isFinite(subCap) && subCap >= 0
      ? positiveInt(subCap)
      : plan.spendCapCents;
  return {
    quotas: sub.usageQuotas ?? plan.quotas,
    rates: sub.usageRates ?? plan.rates,
    spendCapCents,
    featureFees: sub.featureFees ?? plan.featureFees,
    rebilling,
  };
}

/** Workspace `usageQuotas` override, else the plan's quotas, else null. */
export async function getEffectiveQuotas(
  subAccountId: string,
  subAccount?: QuotaSubjectSubAccount | null,
): Promise<UsageQuotas | null> {
  return (await getEffectiveBilling(subAccountId, subAccount)).quotas;
}

/** Workspace override, then plan, then null. */
export async function getEffectiveRates(
  subAccountId: string,
  subAccount?: QuotaSubjectSubAccount | null,
): Promise<UsageRates | null> {
  return (await getEffectiveBilling(subAccountId, subAccount)).rates;
}

function rateFor(rates: UsageRates | null, unit: UsageUnit): number | null {
  const p = PRICED[unit];
  if (!p || !rates) return null;
  return positiveInt(rates[p.rateKey]);
}

/** Has a sell rate, so usage past the allowance accrues instead of stopping. */
export function unitIsPriced(unit: UsageUnit, rates: UsageRates | null): boolean {
  return rateFor(rates, unit) !== null;
}

/** Billable usage past the allowance at sell rates. No allowance bills from unit one. */
export function computeOverage(
  usage: UsageMonthDoc,
  quotas: UsageQuotas | null,
  rates: UsageRates | null,
): {
  perUnit: Partial<Record<UsageUnit, { overUnits: number; cents: number }>>;
  totalCents: number;
} {
  const perUnit: Partial<
    Record<UsageUnit, { overUnits: number; cents: number }>
  > = {};
  let totalCents = 0;
  for (const unit of Object.keys(PRICED) as UsageUnit[]) {
    const p = PRICED[unit]!;
    const rate = rateFor(rates, unit);
    if (rate === null) continue;
    const included = limitFor(quotas, unit, true) ?? 0;
    const used = (usage[p.billable] as number | undefined) ?? 0;
    const overUnits = Math.max(0, used - included);
    if (overUnits <= 0) continue;
    const cents = Math.round((overUnits / (p.perSeconds ?? 1)) * rate);
    perUnit[unit] = { overUnits, cents };
    totalCents += cents;
  }
  return { perUnit, totalCents };
}

export interface FeeLine {
  gateKey: FeeGateKey;
  label: string;
  cents: number;
}

/** Flat fees for gates that were on at some point in the month. */
export function computeFeatureFees(
  usage: UsageMonthDoc,
  fees: FeatureFees | null,
): { lines: FeeLine[]; totalCents: number } {
  const lines: FeeLine[] = [];
  if (!fees) return { lines, totalCents: 0 };
  for (const key of FEE_GATE_KEYS) {
    const fee = fees[key];
    const cents = positiveInt(fee?.cents);
    if (!fee || cents === null || usage.featuresOn?.[key] !== true) continue;
    lines.push({ gateKey: key, label: fee.label || FEE_GATE_LABELS[key], cents });
  }
  return { lines, totalCents: lines.reduce((s, l) => s + l.cents, 0) };
}

/** Limit in ledger units, or null. 0 is a real allowance only when `allowZero`. */
function limitFor(
  quotas: UsageQuotas | null,
  unit: UsageUnit,
  allowZero: boolean,
): number | null {
  if (!quotas) return null;
  const raw = quotas[UNIT_META[unit].quotaKey];
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  if (raw < 0 || (raw === 0 && !(allowZero && PRICED[unit]))) return null;
  return Math.floor(raw) * UNIT_META[unit].quotaFactor;
}

// Input validation (routes + plan editor)

const QUOTA_KEYS: (keyof UsageQuotas)[] = [
  "emailsPerMonth",
  "smsSegmentsPerMonth",
  "whatsappPerMonth",
  "aiTokensPerMonth",
  "aiRepliesPerMonth",
  "voiceMinutesPerMonth",
  "webVoiceMinutesPerMonth",
];

/** Keep known keys with finite integers >= 0. Null when nothing valid is left. */
export function sanitizeUsageQuotas(raw: unknown): UsageQuotas | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const out: UsageQuotas = {};
  for (const key of QUOTA_KEYS) {
    const v = r[key];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
      out[key] = Math.floor(v);
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

const RATE_KEYS: (keyof UsageRates)[] = [
  "emailCents",
  "smsSegmentCents",
  "aiReplyCents",
  "voiceMinuteCents",
  "webVoiceMinuteCents",
];

/** Highest sell rate accepted per unit ($1,000), to catch typos in dollars vs cents. */
const MAX_RATE_CENTS = 100_000;

/** Known priced keys with positive integers; never-billed keys are dropped. */
export function sanitizeUsageRates(raw: unknown): UsageRates | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const out: UsageRates = {};
  for (const key of RATE_KEYS) {
    const v = r[key];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      out[key] = Math.min(MAX_RATE_CENTS, Math.round(v));
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Rates as typed, refusing units the client pays for itself. */
export function validateUsageRates(
  raw: unknown,
  opts: { dedicatedSms?: boolean } = {},
): { ok: true; rates: UsageRates | null } | { ok: false; error: string } {
  if (raw !== null && raw !== undefined && typeof raw !== "object") {
    return { ok: false, error: "Rates must be an object of cents per unit." };
  }
  const r = (raw ?? {}) as Record<string, unknown>;
  if (positiveInt(r.whatsappMessageCents) !== null) {
    return {
      ok: false,
      error:
        "WhatsApp runs on the client's own Twilio account, so it can't be billed per message.",
    };
  }
  if (opts.dedicatedSms && positiveInt(r.smsSegmentCents) !== null) {
    return {
      ok: false,
      error:
        "This client sends SMS on their own Twilio account, so SMS can't be billed per segment.",
    };
  }
  for (const key of RATE_KEYS) {
    const v = r[key];
    if (typeof v === "number" && Number.isFinite(v) && v > MAX_RATE_CENTS) {
      return { ok: false, error: `A rate can't be more than $${MAX_RATE_CENTS / 100} per unit.` };
    }
  }
  return { ok: true, rates: sanitizeUsageRates(raw) };
}

/**
 * Spend ceiling in cents. null clears it. `allowZero` is for a workspace
 * override, where 0 means "no ceiling for this client".
 */
export function validateSpendCap(
  raw: unknown,
  opts: { allowZero?: boolean } = {},
): { ok: true; cents: number | null } | { ok: false; error: string } {
  if (raw === null || raw === undefined || raw === "") return { ok: true, cents: null };
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    return { ok: false, error: "Spend ceiling must be a positive amount in cents." };
  }
  if (raw === 0) {
    return opts.allowZero
      ? { ok: true, cents: 0 }
      : { ok: false, error: "Spend ceiling must be more than zero, or blank for none." };
  }
  return { ok: true, cents: Math.floor(raw) };
}

/** Highest flat fee accepted per feature per month ($10,000). */
const MAX_FEE_CENTS = 1_000_000;

/** Fees keyed by gate. null clears; {} = explicitly no fees. Unknown gates are refused. */
export function validateFeatureFees(
  raw: unknown,
): { ok: true; fees: FeatureFees | null } | { ok: false; error: string } {
  if (raw === null || raw === undefined) return { ok: true, fees: null };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "Feature fees must be an object keyed by feature." };
  }
  const out: FeatureFees = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(FEE_GATE_KEYS as readonly string[]).includes(key)) {
      return { ok: false, error: `Unknown feature for a fee: ${key}.` };
    }
    if (value === null || value === undefined) continue;
    const v = value as { label?: unknown; cents?: unknown };
    const cents = positiveInt(v.cents);
    // Refused rather than skipped: on an override, a skipped entry would
    // silently replace the plan's fees with fewer.
    if (cents === null || typeof value !== "object") {
      return {
        ok: false,
        error: `The fee for ${FEE_GATE_LABELS[key as FeeGateKey]} must be a positive amount.`,
      };
    }
    if (cents > MAX_FEE_CENTS) {
      return { ok: false, error: `A feature fee can't be more than $${MAX_FEE_CENTS / 100} a month.` };
    }
    const label =
      typeof v.label === "string" && v.label.trim()
        ? v.label.trim().slice(0, 60)
        : FEE_GATE_LABELS[key as FeeGateKey];
    out[key as FeeGateKey] = { label, cents };
  }
  return { ok: true, fees: out };
}

// Enforcement

/** Monthly cap or spend ceiling hit. */
export class UsageQuotaExceededError extends Error {
  readonly unit: UsageUnit;
  readonly reason: "quota" | "spend_cap";
  constructor(unit: UsageUnit, reason: "quota" | "spend_cap" = "quota") {
    const { label } = UNIT_META[unit];
    super(
      reason === "spend_cap"
        ? "This workspace has reached its monthly usage spending limit. Paid channels resume at the start of next month, or the limit can be raised by the platform owner."
        : `Monthly ${label} limit reached for this workspace. It resets at the start of next month, or the limit can be raised by the platform owner.`,
    );
    this.name = "UsageQuotaExceededError";
    this.unit = unit;
    this.reason = reason;
  }
}

/** Room for one more unit? Priced units on a rebilled client stop only at the ceiling. Fails open. */
export async function checkQuota(input: {
  subAccountId: string;
  unit: UsageUnit;
  subAccount?: QuotaSubjectSubAccount | null;
  /** Already resolved by the caller; skips a second lookup. */
  billing?: EffectiveBilling;
}): Promise<{ allowed: boolean; error?: UsageQuotaExceededError }> {
  return checkQuotas({
    subAccountId: input.subAccountId,
    units: [input.unit],
    subAccount: input.subAccount,
    billing: input.billing,
  });
}

/** checkQuota for several units with one billing lookup and one ledger read; the first block wins. */
export async function checkQuotas(input: {
  subAccountId: string;
  units: UsageUnit[];
  subAccount?: QuotaSubjectSubAccount | null;
  billing?: EffectiveBilling;
}): Promise<{ allowed: boolean; error?: UsageQuotaExceededError }> {
  try {
    const sub = input.subAccount ?? (await loadSubAccount(input.subAccountId));
    const b = input.billing ?? (await getEffectiveBilling(input.subAccountId, sub));
    let usage: UsageMonthDoc | null = null;
    const readUsage = async (): Promise<UsageMonthDoc> => {
      if (!usage) {
        const snap = await monthRef(input.subAccountId, usageMonthKey()).get();
        usage = (snap.data() as UsageMonthDoc | undefined) ?? {};
      }
      return usage;
    };
    for (const unit of input.units) {
      if (b.rebilling && unitIsPriced(unit, b.rates)) {
        if (b.spendCapCents === null) continue;
        // SMS on the client's own Twilio adds nothing to the bill, so the ceiling doesn't stop it.
        if (unit === "smsSegments" && sub?.twilioConfig?.enabled === true) continue;
        const u = await readUsage();
        if (computeOverage(u, b.quotas, b.rates).totalCents >= b.spendCapCents) {
          return { allowed: false, error: new UsageQuotaExceededError(unit, "spend_cap") };
        }
        continue;
      }
      // Unpriced here, so 0 can only mean unlimited (it's "pay as you go" only with a rate).
      const limit = limitFor(b.quotas, unit, false);
      if (limit === null) continue;
      const used = (await readUsage())[unit] ?? 0;
      if (used >= limit) {
        return { allowed: false, error: new UsageQuotaExceededError(unit) };
      }
    }
    return { allowed: true };
  } catch (err) {
    console.warn("[usage-meter] checkQuota failed (failing open)", {
      subAccountId: input.subAccountId,
      units: input.units,
      err,
    });
    return { allowed: true };
  }
}

// Recording + owner alerts

/** Increment the month ledger and check the 80%/100% alerts. Never throws. */
export async function recordUsage(input: {
  subAccountId: string;
  unit: UsageUnit;
  qty: number;
  subAccount?: QuotaSubjectSubAccount | null;
  /** Extra counters bumped by the same qty in the same write (e.g. the billable twin). */
  also?: UsageCounter[];
}): Promise<void> {
  try {
    const qty = Math.floor(input.qty);
    if (!Number.isFinite(qty) || qty <= 0) return;
    const month = usageMonthKey();
    const ref = monthRef(input.subAccountId, month);
    const increments: Record<string, FieldValue> = {
      [input.unit]: FieldValue.increment(qty),
    };
    for (const c of input.also ?? []) increments[c] = FieldValue.increment(qty);
    await ref.set(
      { ...increments, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    await checkThresholds(input.subAccountId, input.unit, input.subAccount);
  } catch (err) {
    console.warn("[usage-meter] recordUsage failed", {
      subAccountId: input.subAccountId,
      unit: input.unit,
      err,
    });
  }
}

/** Set a once-per-month alert stamp; true only for the call that set it. */
async function claimStamp(
  ref: FirebaseFirestore.DocumentReference,
  group: "warnedAt" | "cappedAt" | "clientCappedAt" | "ceiling",
  key: string,
): Promise<boolean> {
  return getAdminDb().runTransaction(async (tx) => {
    const data = (await tx.get(ref)).data() as Record<string, Record<string, unknown> | undefined> | undefined;
    if (data?.[group]?.[key]) return false;
    tx.set(ref, { [group]: { [key]: FieldValue.serverTimestamp() } }, { merge: true });
    return true;
  });
}

/** 80%/100% alerts for allowances and the spend ceiling, once per month each. Never throws. */
export async function checkThresholds(
  subAccountId: string,
  unit: UsageUnit,
  subAccount?: QuotaSubjectSubAccount | null,
): Promise<void> {
  try {
    const b = await getEffectiveBilling(subAccountId, subAccount);
    const limit = limitFor(b.quotas, unit, false);
    const priced = b.rebilling && unitIsPriced(unit, b.rates);
    const ceiling = priced ? b.spendCapCents : null;
    if (limit === null && ceiling === null) return;
    const ref = monthRef(subAccountId, usageMonthKey());
    const data = ((await ref.get()).data() as UsageMonthDoc | undefined) ?? {};

    if (limit !== null) {
      const used = (data[priced ? PRICED[unit]!.billable : unit] as number | undefined) ?? 0;
      const pct = (used / limit) * 100;
      if (pct >= 100 && (await claimStamp(ref, "cappedAt", unit))) {
        runAfterResponse(() => notifyOwner(subAccountId, unit, 100, used, limit, priced));
      } else if (pct >= 80 && pct < 100 && (await claimStamp(ref, "warnedAt", unit))) {
        runAfterResponse(() => notifyOwner(subAccountId, unit, 80, used, limit, priced));
      }
    }

    // Its own stamp, so a client switched to rebilling after an owner-only cap
    // alert still hears that usage is now billed.
    if (limit !== null && priced) {
      const used = (data[PRICED[unit]!.billable] as number | undefined) ?? 0;
      if (used >= limit && (await claimStamp(ref, "clientCappedAt", unit))) {
        runAfterResponse(() => notifyClient(subAccountId, { kind: "included", unit }));
      }
    }

    if (ceiling !== null) {
      const spent = computeOverage(data, b.quotas, b.rates).totalCents;
      const pct = (spent / ceiling) * 100;
      const level = pct >= 100 ? 100 : pct >= 80 ? 80 : null;
      if (level !== null && (await claimStamp(ref, "ceiling", String(level)))) {
        runAfterResponse(() => notifyOwnerCeiling(subAccountId, level, spent, ceiling));
        runAfterResponse(() =>
          notifyClient(subAccountId, { kind: "ceiling", level, spentCents: spent, ceilingCents: ceiling }),
        );
      }
    }
  } catch (err) {
    console.warn("[usage-meter] threshold check failed", { subAccountId, unit, err });
  }
}

/**
 * Bump counters that have no allowance (no threshold alerts). Never throws, so
 * callers can fire it without a catch.
 */
export async function recordCounter(input: {
  subAccountId: string;
  counter: UsageCounter;
  qty: number;
}): Promise<void> {
  try {
    const qty = Math.floor(input.qty);
    if (!Number.isFinite(qty) || qty <= 0) return;
    await monthRef(input.subAccountId, usageMonthKey()).set(
      {
        [input.counter]: FieldValue.increment(qty),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  } catch (err) {
    console.warn("[usage-meter] recordCounter failed", {
      subAccountId: input.subAccountId,
      counter: input.counter,
      err,
    });
  }
}

/**
 * Add an OpenRouter call's actual cost (USD, from `usage.cost`) to the
 * workspace ledger. Agency-internal calls are dropped. Never throws.
 */
export async function recordAiCost(meter: AiMeter, costUsd: number): Promise<void> {
  if (!("subAccountId" in meter) || !meter.subAccountId) return;
  try {
    const micros = Math.round(costUsd * 1_000_000);
    if (!Number.isFinite(micros) || micros <= 0) return;
    await monthRef(meter.subAccountId, usageMonthKey()).set(
      {
        aiCostMicros: FieldValue.increment(micros),
        aiCostBySource: { [meter.source]: FieldValue.increment(micros) },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  } catch (err) {
    console.warn("[usage-meter] recordAiCost failed", {
      subAccountId: meter.subAccountId,
      err,
    });
  }
}

// Flat-fee tracking

/** Mark gates as on for this month (flat fees bill from this). Never throws. */
export async function stampFeaturesOn(
  subAccountId: string,
  keys: FeeGateKey[],
): Promise<void> {
  if (keys.length === 0) return;
  try {
    const featuresOn: Partial<Record<FeeGateKey, boolean>> = {};
    for (const k of keys) featuresOn[k] = true;
    await monthRef(subAccountId, usageMonthKey()).set(
      { featuresOn, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
  } catch (err) {
    console.warn("[usage-meter] stampFeaturesOn failed", { subAccountId, err });
  }
}

/** Every fee gate currently on for this sub-account doc. */
export function gatesOnNow(sub: Partial<Record<FeeGateKey, unknown>>): FeeGateKey[] {
  return FEE_GATE_KEYS.filter((k) => feeGateOn(sub, k));
}

function formatUnits(unit: UsageUnit, n: number): string {
  if (unit === "voiceSeconds" || unit === "webVoiceSeconds") {
    return `${Math.round(n / 60)} min`;
  }
  return n.toLocaleString();
}

/** The agency owner's uid and best email for a workspace's alerts. */
async function ownerContact(
  subAccountId: string,
): Promise<{ sub: QuotaSubjectSubAccount; ownerUid: string | null; to: string | null } | null> {
  const db = getAdminDb();
  const sub = await loadSubAccount(subAccountId);
  if (!sub?.agencyId) return null;
  const agencySnap = await db.doc(`agencies/${sub.agencyId}`).get();
  const ownerUid = (agencySnap.data()?.ownerUid as string | undefined) ?? null;
  let to: string | null = null;
  if (ownerUid) {
    const ownerSnap = await db.doc(`users/${ownerUid}`).get();
    to = (ownerSnap.data()?.email as string | undefined) ?? null;
  }
  to = to ?? (agencySnap.data()?.supportEmail as string | undefined) ?? null;
  return { sub, ownerUid, to };
}

/** Email + push to the agency owner only (never the workspace's members). */
async function alertOwner(
  subAccountId: string,
  subject: string,
  text: string,
  tag: string,
): Promise<void> {
  const owner = await ownerContact(subAccountId);
  if (!owner) return;
  // Dynamic imports: resend.ts meters through this module, so static ones would cycle.
  const { emailIsConfigured, sendEmail } = await import("@/lib/comms/resend");
  if (owner.to && emailIsConfigured()) {
    await sendEmail({ to: owner.to, subject, text }).catch((err) =>
      console.warn("[usage-meter] owner alert email failed", { subAccountId, err }),
    );
  }
  if (owner.ownerUid) {
    const { sendPushToUser } = await import("@/lib/push/send");
    await sendPushToUser({
      uid: owner.ownerUid,
      title: subject,
      body: text.split("\n").find((l) => l.trim()) ?? subject,
      url: "/agency/billing",
      tag: `usage-${subAccountId}-${tag}`,
    });
  }
}

async function notifyOwner(
  subAccountId: string,
  unit: UsageUnit,
  threshold: 80 | 100,
  used: number,
  limit: number,
  priced: boolean,
): Promise<void> {
  try {
    const sub = await loadSubAccount(subAccountId);
    const { label, plural } = UNIT_META[unit];
    const wsName = sub?.name || subAccountId;
    const subject = priced
      ? threshold === 100
        ? `${wsName} is past its included ${plural} this month`
        : `${wsName} has used 80% of its included ${plural}`
      : threshold === 100
        ? `${wsName} hit its monthly ${label} limit`
        : `${wsName} has used 80% of its monthly ${label} quota`;
    const body = priced
      ? threshold === 100
        ? `Further use keeps working and is billed at this client's rate, up to any spend ceiling you set.`
        : `Past 100%, further use is billed at this client's rate.`
      : threshold === 100
        ? `That channel's sends are now paused for this workspace until the month resets, or until you raise the limit on the client's Client billing plan (Agency → Client billing) or ask the Agency Assistant to set a higher limit for this workspace.`
        : `At 100% that channel's sends pause for this workspace. To raise it, edit the client's Client billing plan (Agency → Client billing) or ask the Agency Assistant to set a higher limit for this workspace.`;
    const text = [
      `${wsName} — ${label} usage this month: ${formatUnits(unit, used)} of ${formatUnits(unit, limit)}${priced ? " included" : ""}.`,
      "",
      body,
    ].join("\n");
    await alertOwner(subAccountId, subject, text, `${unit}-${threshold}`);
  } catch (err) {
    console.warn("[usage-meter] owner alert failed", { subAccountId, unit, err });
  }
}

/** In the client's plan currency (usd without a plan), like the usage charge. */
function money(cents: number, sub: QuotaSubjectSubAccount | null | undefined): string {
  return formatBillingPrice(cents, sub?.billing?.currency ?? "usd");
}

async function notifyOwnerCeiling(
  subAccountId: string,
  level: 80 | 100,
  spentCents: number,
  ceilingCents: number,
): Promise<void> {
  try {
    const sub = await loadSubAccount(subAccountId);
    const wsName = sub?.name || subAccountId;
    const subject =
      level === 100
        ? `${wsName} reached its usage spend ceiling`
        : `${wsName} is at 80% of its usage spend ceiling`;
    const text = [
      `${wsName} — billable usage this month: ${money(spentCents, sub)} of a ${money(ceilingCents, sub)} ceiling.`,
      "",
      level === 100
        ? "Priced channels are paused for this client until the month resets, or until you raise the ceiling (Manage → Billing & usage)."
        : "At the ceiling, priced channels pause for this client until the month resets.",
    ].join("\n");
    await alertOwner(subAccountId, subject, text, `ceiling-${level}`);
  } catch (err) {
    console.warn("[usage-meter] ceiling alert failed", { subAccountId, err });
  }
}

/** Tell the client's billing contact that usage is now billed or near the ceiling. */
async function notifyClient(
  subAccountId: string,
  event:
    | { kind: "included"; unit: UsageUnit }
    | { kind: "ceiling"; level: 80 | 100; spentCents: number; ceilingCents: number },
): Promise<void> {
  try {
    const { emailIsConfigured, sendEmail } = await import("@/lib/comms/resend");
    if (!emailIsConfigured()) return;
    const snap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
    if (!snap.exists) return;
    const sub = { ...(snap.data() as import("@/types").SubAccountDoc), id: snap.id };
    const { billingRecipient } = await import("@/lib/server/usage-billing-service");
    const to = await billingRecipient(sub);
    if (!to) return;
    const ws = sub.name || "Your workspace";
    const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
    const link = base ? `${base}/sa/${subAccountId}/dashboard/settings?tab=billing` : null;
    let subject: string;
    let lines: string[];
    if (event.kind === "included") {
      const { plural } = UNIT_META[event.unit];
      const b = await getEffectiveBilling(subAccountId);
      const rate = rateFor(b.rates, event.unit);
      const per = PRICED[event.unit]?.perSeconds ? "per minute" : "each";
      subject = `${ws}: included ${plural} used for this month`;
      lines = [
        `${ws} has used all the ${plural} included this month.`,
        "",
        rate !== null
          ? `Further use keeps working and is billed at ${money(rate, sub)} ${per}, on your usage charge on the 1st.`
          : "Further use keeps working and is billed on your usage charge on the 1st.",
      ];
    } else {
      subject =
        event.level === 100
          ? `${ws} reached its monthly spending limit`
          : `${ws} is at 80% of its monthly spending limit`;
      lines = [
        `Billable usage for ${ws} this month: ${money(event.spentCents, sub)} of a ${money(event.ceilingCents, sub)} limit.`,
        "",
        event.level === 100
          ? "Paid services (like AI replies and calls) are paused until next month. Contact your provider to raise the limit."
          : "At the limit, paid services pause until next month.",
      ];
    }
    if (link) lines.push("", `Details: ${link}`);
    await sendEmail({ to, subject, text: lines.join("\n") });
  } catch (err) {
    console.warn("[usage-meter] client alert failed", { subAccountId, err });
  }
}
