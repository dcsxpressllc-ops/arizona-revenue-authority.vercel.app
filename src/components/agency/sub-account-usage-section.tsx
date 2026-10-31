"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Gauge, Loader2, Lock, Receipt, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatBillingPrice } from "@/lib/billing/status";
import { formatUsageMonth } from "@/lib/billing/usage";
import {
  USAGE_UNIT_META,
  centsToDollars,
  displayUnits,
  dollarsToCents,
  type UsageUnitMeta,
} from "@/lib/billing/usage-units";
import { FEE_GATE_KEYS, FEE_GATE_LABELS, feeGateOn, type FeeGateKey } from "@/types/billing";
import type { AiCostSource, FeatureFees, UsageQuotas, UsageRates } from "@/types/usage";
import type { AgencyUsageResponse } from "@/types/usage-billing";
import type { SubAccountDoc } from "@/types";

/** Manage dialog Billing & usage tab. The ledger is server-only, so data comes from the owner API. */

const COST_LABELS: Record<AiCostSource, string> = {
  replies: "Replies",
  voice: "Phone voice",
  webVoice: "Web voice",
  assistant: "Workspace Assistant",
  workflows: "Workflows",
  watchdog: "Watchdog",
  other: "Other",
};

function microsToCents(micros: number): number {
  return Math.round(micros / 10_000);
}

export function SubAccountUsageSection({ subAccount }: { subAccount: SubAccountDoc }) {
  const subAccountId = subAccount.id;
  const [data, setData] = useState<AgencyUsageResponse | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const r = await fetch(`/api/agency/sub-accounts/${subAccountId}/usage`);
      if (!r.ok) throw new Error(String(r.status));
      setData((await r.json()) as AgencyUsageResponse);
    } catch {
      setFailed(true);
    }
  }, [subAccountId]);

  useEffect(() => {
    setData(null);
    void load();
  }, [load]);

  if (failed) {
    return (
      <p className="rounded-xl border p-4 text-xs text-muted-foreground">
        Couldn&apos;t load usage right now.
      </p>
    );
  }
  if (!data) return <div className="h-40 animate-pulse rounded-xl bg-muted/40" />;

  return (
    <div className="space-y-4">
      <RebillingCard subAccount={subAccount} data={data} onSaved={load} />
      <UsageCard data={data} />
    </div>
  );
}

// Rebilling switch + pricing editor

function RebillingCard({
  subAccount,
  data,
  onSaved,
}: {
  subAccount: SubAccountDoc;
  data: AgencyUsageResponse;
  onSaved: () => Promise<void>;
}) {
  const { rebilling, config } = data;
  const [confirming, setConfirming] = useState<null | boolean>(null);
  const [busy, setBusy] = useState(false);

  async function patch(body: Record<string, unknown>, ok: string): Promise<boolean> {
    setBusy(true);
    try {
      const res = await fetch(`/api/agency/sub-accounts/${subAccount.id}/feature-gates`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(d.error ?? "Couldn't save.");
      toast.success(ok);
      await onSaved();
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Receipt className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">Usage rebilling</h3>
            <span
              className={
                "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide " +
                (rebilling.active
                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : "bg-muted text-muted-foreground")
              }
            >
              {rebilling.active ? "Rebilled" : "Metering only"}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {rebilling.active
              ? "Usage past the included amounts and the flat fees below are billed on the 1st for the month before, payable within 14 days."
              : rebilling.agency
                ? "Usage is counted but not billed. Turn this on to bill this client monthly in arrears."
                : "Usage rebilling is off for the agency."}
            {!rebilling.agency && (
              <>
                {" "}
                <Link href="/agency/billing" className="underline">
                  Turn it on in Client billing
                </Link>
                .
              </>
            )}
          </p>
        </div>
        {confirming === null ? (
          <Button
            type="button"
            size="sm"
            variant={rebilling.client ? "outline" : "default"}
            disabled={busy || (!rebilling.client && !rebilling.agency)}
            onClick={() => setConfirming(!rebilling.client)}
          >
            {rebilling.client ? "Stop rebilling" : "Rebill this client"}
          </Button>
        ) : null}
      </div>

      {confirming !== null && (
        <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
          <p className="text-amber-800 dark:text-amber-300">
            {confirming
              ? "The whole of this month will be billed on the 1st, including flat fees for features that are on this month."
              : "This month won't be billed. Charges already sent stay payable."}
          </p>
          <div className="mt-2 flex gap-2">
            <Button
              type="button"
              size="sm"
              className="h-7 text-xs"
              disabled={busy}
              onClick={async () => {
                const ok = await patch(
                  { usageRebillingEnabled: confirming },
                  confirming ? "This client is now rebilled." : "Rebilling stopped for this client.",
                );
                if (ok) setConfirming(null);
              }}
            >
              {busy && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
              {confirming ? "Yes, rebill" : "Yes, stop"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              disabled={busy}
              onClick={() => setConfirming(null)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      <PricingEditor subAccount={subAccount} config={config} busy={busy} onSave={patch} />
    </section>
  );
}

type Mode = "plan" | "custom";

function PricingEditor({
  subAccount,
  config,
  busy,
  onSave,
}: {
  subAccount: SubAccountDoc;
  config: AgencyUsageResponse["config"];
  busy: boolean;
  onSave: (body: Record<string, unknown>, ok: string) => Promise<boolean>;
}) {
  const { overrides, plan, dedicatedSms } = config;
  const hasOverride =
    overrides.usageQuotas !== null ||
    overrides.usageRates !== null ||
    overrides.usageSpendCapCents !== null ||
    overrides.featureFees !== null;
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>(hasOverride || !plan ? "custom" : "plan");
  // Reseed only when the saved pricing changes, not on every reload (e.g. the
  // rebilling switch), so unsaved edits survive.
  const seedKey = JSON.stringify({ overrides, plan });

  // Custom inputs start from the override, else the plan, so switching is non-destructive.
  const seed = useMemo(() => {
    const q = overrides.usageQuotas ?? plan?.quotas ?? {};
    const r = overrides.usageRates ?? plan?.rates ?? {};
    const fees = overrides.featureFees ?? plan?.featureFees ?? {};
    const cap = overrides.usageSpendCapCents ?? plan?.spendCapCents ?? null;
    return { q, r, fees, cap };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedKey]);
  const [included, setIncluded] = useState<Record<string, string>>({});
  const [rates, setRates] = useState<Record<string, string>>({});
  const [fees, setFees] = useState<Record<string, string>>({});
  const [cap, setCap] = useState("");

  useEffect(() => {
    const inc: Record<string, string> = {};
    const rt: Record<string, string> = {};
    for (const u of USAGE_UNIT_META) {
      const v = (seed.q as UsageQuotas)[u.quotaKey];
      inc[u.quotaKey] = typeof v === "number" ? String(v) : "";
      if (u.rateKey) rt[u.rateKey] = centsToDollars((seed.r as UsageRates)[u.rateKey]);
    }
    const fe: Record<string, string> = {};
    for (const k of FEE_GATE_KEYS) fe[k] = centsToDollars((seed.fees as FeatureFees)[k]?.cents);
    setIncluded(inc);
    setRates(rt);
    setFees(fe);
    setCap(centsToDollars(seed.cap));
  }, [seed]);

  // Fees only make sense for features this client has on, or that already carry one.
  const feeKeys = FEE_GATE_KEYS.filter(
    (k) => feeGateOn(subAccount as unknown as Record<FeeGateKey, unknown>, k) || (fees[k] ?? "") !== "",
  );

  async function save() {
    if (mode === "plan") {
      await onSave(
        { usageQuotas: null, usageRates: null, usageSpendCapCents: null, featureFees: null },
        "This client now uses the plan's pricing.",
      );
      return;
    }
    const q: Record<string, number> = {};
    for (const u of USAGE_UNIT_META) {
      const n = Number.parseInt((included[u.quotaKey] ?? "").trim(), 10);
      if (Number.isFinite(n) && n >= 0) q[u.quotaKey] = n;
    }
    const r: Record<string, number> = {};
    for (const u of USAGE_UNIT_META) {
      if (!u.rateKey || (u.rateKey === "smsSegmentCents" && dedicatedSms)) continue;
      const c = dollarsToCents(rates[u.rateKey] ?? "");
      if (c) r[u.rateKey] = c;
    }
    const f: FeatureFees = {};
    for (const k of FEE_GATE_KEYS) {
      const c = dollarsToCents(fees[k] ?? "");
      if (c) f[k] = { label: FEE_GATE_LABELS[k], cents: c };
    }
    await onSave(
      {
        usageQuotas: q,
        usageRates: r,
        // Blank = no ceiling for this client (0), not the plan's.
        usageSpendCapCents: dollarsToCents(cap) ?? 0,
        featureFees: f,
      },
      "Pricing saved for this client.",
    );
  }

  return (
    <div className="mt-3 border-t pt-3">
      <button
        type="button"
        className="text-xs font-medium underline-offset-2 hover:underline"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? "Hide pricing" : `Pricing: ${hasOverride ? "custom for this client" : plan ? `from plan “${plan.name}”` : "not set"}`}
      </button>

      {open && (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap gap-4 text-xs">
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="pricing-mode"
                checked={mode === "plan"}
                disabled={!plan || busy}
                onChange={() => setMode("plan")}
              />
              Use the plan&apos;s pricing{plan ? ` (${plan.name})` : " (no plan assigned)"}
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="pricing-mode"
                checked={mode === "custom"}
                disabled={busy}
                onChange={() => setMode("custom")}
              />
              Custom for this client
            </label>
          </div>

          {mode === "custom" && (
            <>
              <div className="grid items-center gap-x-3 gap-y-2 sm:grid-cols-[1.2fr_1fr_1fr]">
                <span className="hidden text-[11px] font-medium uppercase tracking-wide text-muted-foreground sm:block">
                  Unit
                </span>
                <span className="hidden text-[11px] font-medium uppercase tracking-wide text-muted-foreground sm:block">
                  Included / month
                </span>
                <span className="hidden text-[11px] font-medium uppercase tracking-wide text-muted-foreground sm:block">
                  Rate ($)
                </span>
                {USAGE_UNIT_META.map((u) => (
                  <UnitRow
                    key={u.quotaKey}
                    meta={u}
                    dedicatedSms={dedicatedSms}
                    included={included[u.quotaKey] ?? ""}
                    rate={u.rateKey ? (rates[u.rateKey] ?? "") : ""}
                    disabled={busy}
                    onIncluded={(v) => setIncluded((p) => ({ ...p, [u.quotaKey]: v }))}
                    onRate={(v) => u.rateKey && setRates((p) => ({ ...p, [u.rateKey!]: v }))}
                  />
                ))}
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                While this client is rebilled, a rate lets usage continue past the
                included amount (blank = billed from the first unit). Without a
                rate, or while not rebilled, the included amount is a hard cap
                (blank = unlimited). Rates are in whole cents.
              </p>

              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-medium">Spend ceiling ($ / month)</span>
                <Input
                  type="number"
                  min={1}
                  step={1}
                  inputMode="decimal"
                  className="h-8 w-32 text-sm"
                  value={cap}
                  placeholder="None"
                  disabled={busy}
                  onChange={(e) => setCap(e.target.value)}
                  aria-label="Monthly spend ceiling in dollars"
                />
                <span className="text-muted-foreground">
                  Priced channels pause once billable usage reaches it.
                </span>
              </div>

              {feeKeys.length > 0 && (
                <div>
                  <p className="mb-1.5 text-xs font-medium">Flat monthly fees</p>
                  <div className="grid items-center gap-x-3 gap-y-1.5 sm:grid-cols-[1.6fr_1fr]">
                    {feeKeys.map((k) => (
                      <div key={k} className="contents">
                        <span className="text-xs">{FEE_GATE_LABELS[k]}</span>
                        <Input
                          type="number"
                          min={0.5}
                          step={1}
                          inputMode="decimal"
                          className="h-8 text-sm"
                          value={fees[k] ?? ""}
                          placeholder="No fee"
                          disabled={busy}
                          onChange={(e) => setFees((p) => ({ ...p, [k]: e.target.value }))}
                          aria-label={`${FEE_GATE_LABELS[k]} monthly fee in dollars`}
                        />
                      </div>
                    ))}
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Billed for any month the feature is on, even on the client&apos;s own
                    provider. Features this client doesn&apos;t have are hidden.
                  </p>
                </div>
              )}
            </>
          )}

          <Button type="button" size="sm" disabled={busy} onClick={save}>
            {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
            Save pricing
          </Button>
        </div>
      )}
    </div>
  );
}

function UnitRow({
  meta,
  dedicatedSms,
  included,
  rate,
  disabled,
  onIncluded,
  onRate,
}: {
  meta: UsageUnitMeta;
  dedicatedSms: boolean;
  included: string;
  rate: string;
  disabled: boolean;
  onIncluded: (v: string) => void;
  onRate: (v: string) => void;
}) {
  const lockedReason =
    meta.capOnlyReason ??
    (meta.rateKey === "smsSegmentCents" && dedicatedSms
      ? "Runs on the client's own Twilio, so it can't be metered."
      : null);
  return (
    <div className="contents">
      <span className="pt-2 text-sm sm:pt-0">{meta.label}</span>
      <Input
        type="number"
        min={0}
        inputMode="numeric"
        className="h-8 text-sm"
        aria-label={`${meta.label} included per month`}
        value={included}
        placeholder="None"
        disabled={disabled}
        onChange={(e) => onIncluded(e.target.value)}
      />
      {lockedReason ? (
        <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <Lock className="h-3 w-3 shrink-0" />
          {lockedReason}
        </span>
      ) : (
        <Input
          type="number"
          min={0.01}
          step={0.01}
          inputMode="decimal"
          className="h-8 text-sm"
          aria-label={`${meta.label} rate in dollars ${meta.per}`}
          value={rate}
          placeholder={meta.per}
          disabled={disabled}
          onChange={(e) => onRate(e.target.value)}
        />
      )}
    </div>
  );
}

// Usage readout

function UsageCard({ data }: { data: AgencyUsageResponse }) {
  const current = data.usage[0];
  const money = (c: number) => formatBillingPrice(c, data.currency);
  const costCents = microsToCents(current.aiCostMicros);
  const capPct =
    data.spendCapCents && data.spendCapCents > 0
      ? Math.min(100, ((data.overage.totalCents) / data.spendCapCents) * 100)
      : null;

  return (
    <section className="rounded-xl border p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Gauge className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Usage — {formatUsageMonth(current.month)}</h3>
        </div>
        <span className="text-[11px] text-muted-foreground">
          {data.quotaSource === "workspace"
            ? "Limits: this client"
            : data.quotaSource === "plan"
              ? "Limits: from plan"
              : "No limits set"}
        </span>
      </div>

      <div className="space-y-2.5">
        {USAGE_UNIT_META.map((u) => {
          const used = current[u.field] as number;
          const quotaRaw = data.quotas?.[u.quotaKey];
          const limit =
            typeof quotaRaw === "number" && quotaRaw > 0
              ? quotaRaw * (u.minutes ? 60 : 1)
              : null;
          const pct = limit ? Math.min(100, (used / limit) * 100) : null;
          const over = data.overage.perUnit[u.field as keyof typeof data.overage.perUnit];
          const sharedNote =
            u.field === "smsSegments" && current.smsSegmentsShared !== current.smsSegments
              ? ` (${current.smsSegmentsShared.toLocaleString()} on the shared number)`
              : "";
          return (
            <div key={u.field}>
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="text-muted-foreground">
                  {u.label}
                  {sharedNote}
                </span>
                <span className="font-medium tabular-nums">
                  {displayUnits(u, used)}
                  {limit !== null ? ` / ${displayUnits(u, limit)}` : ""}
                  {over && over.cents > 0 && (
                    <span className="ml-2 text-amber-600 dark:text-amber-400">{money(over.cents)}</span>
                  )}
                </span>
              </div>
              {pct !== null && (
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className={`h-full rounded-full ${
                      pct >= 100 ? "bg-rose-500" : pct >= 80 ? "bg-amber-500" : "bg-emerald-500"
                    }`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              )}
            </div>
          );
        })}
        <p className="text-[11px] text-muted-foreground">
          Softphone {Math.round(current.softphoneSeconds / 60).toLocaleString()} min (client&apos;s
          own Twilio) · Website reads {current.firecrawlScrapes.toLocaleString()}
        </p>
      </div>

      {data.rebilling.active && (
        <div className="mt-3 rounded-lg border bg-muted/30 px-3 py-2 text-xs">
          <div className="flex items-baseline justify-between">
            <span className="font-medium">Next usage charge (est.)</span>
            <span className="font-semibold tabular-nums">{money(data.estimatedCents)}</span>
          </div>
          {data.fees.lines.length > 0 && (
            <p className="mt-1 text-muted-foreground">
              Includes fees: {data.fees.lines.map((l) => `${l.label} ${money(l.cents)}`).join(", ")}
            </p>
          )}
          {data.carriedInCents > 0 && (
            <p className="mt-1 text-muted-foreground">
              Includes {money(data.carriedInCents)} carried from last month.
            </p>
          )}
          {capPct !== null && (
            <p className="mt-1 text-muted-foreground">
              Spend ceiling: {money(data.overage.totalCents)} of {money(data.spendCapCents!)} used
              {capPct >= 100 ? " — priced channels are paused" : ""}.
            </p>
          )}
        </div>
      )}

      <div className="mt-3 rounded-lg border border-violet-500/20 bg-violet-500/5 px-3 py-2 text-xs">
        <div className="flex items-baseline justify-between">
          <span className="flex items-center gap-1.5 font-medium">
            <Sparkles className="h-3.5 w-3.5 text-violet-500" />
            Your AI cost this month
          </span>
          <span className="font-semibold tabular-nums">{formatBillingPrice(costCents, "usd")}</span>
        </div>
        {costCents > 0 && (
          <p className="mt-1 text-muted-foreground">
            {(Object.entries(current.aiCostBySource) as [AiCostSource, number][])
              .filter(([, m]) => m > 0)
              .map(([s, m]) => `${COST_LABELS[s]} ${formatBillingPrice(microsToCents(m), "usd")}`)
              .join(" · ")}
          </p>
        )}
        <p className="mt-1 text-[11px] text-muted-foreground">
          What OpenRouter charged you for this client. Only you see this.
        </p>
      </div>

      {data.lastClosed && (
        <p className="mt-3 text-xs text-muted-foreground">
          {formatUsageMonth(data.lastClosed.month)}:{" "}
          {data.lastClosed.skipped
            ? "not billed (rebilling was off)."
            : data.lastClosed.chargeId
              ? `${money(data.lastClosed.totalCents)} charged — see the charges list above.`
              : data.lastClosed.carryOutCents > 0
                ? `${money(data.lastClosed.carryOutCents)} carried into this month (below the minimum).`
                : "nothing to bill."}
        </p>
      )}

      {data.usage.length > 1 && (
        <div className="mt-3 border-t pt-2">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Recent months
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-0.5 pr-2 font-normal">Month</th>
                  {USAGE_UNIT_META.map((u) => (
                    <th key={u.field} className="py-0.5 pr-2 font-normal">
                      {u.label}
                    </th>
                  ))}
                  <th className="py-0.5 pr-2 font-normal">AI cost</th>
                </tr>
              </thead>
              <tbody>
                {data.usage.map((m) => (
                  <tr key={m.month}>
                    <td className="py-0.5 pr-2 text-muted-foreground">{m.month}</td>
                    {USAGE_UNIT_META.map((u) => (
                      <td key={u.field} className="py-0.5 pr-2">
                        {displayUnits(u, m[u.field] as number)}
                      </td>
                    ))}
                    <td className="py-0.5 pr-2">
                      {formatBillingPrice(microsToCents(m.aiCostMicros), "usd")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
