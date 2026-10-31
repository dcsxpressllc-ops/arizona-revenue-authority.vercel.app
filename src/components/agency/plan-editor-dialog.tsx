"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  FEE_GATE_KEYS,
  FEE_GATE_LABELS,
  PLAN_GATE_KEYS,
  PLAN_GATE_LABELS,
  type BillingPlanResponse,
  type FeeGateKey,
  type PlanGates,
} from "@/types/billing";
import {
  USAGE_UNIT_META,
  centsToDollars,
  dollarsToCents,
} from "@/lib/billing/usage-units";

/**
 * Create/edit a billing plan: monthly price plus the feature gates it enables.
 * Currency is fixed after creation (Stripe prices are single-currency); a price
 * edit mints a new Stripe price and existing subscribers keep theirs.
 */

const CURRENCIES = ["usd", "aud", "eur", "gbp", "cad", "nzd"] as const;

/**
 * AI-channel gates that are on by default platform-wide. New plans include
 * them so a plan doesn't silently lock a channel. Other gates start unbundled.
 * Keep in sync with the defaultOn channels in lib/comms/ai/gates.ts.
 */
const DEFAULT_ON_PLAN_GATES: ReadonlySet<string> = new Set([
  "smsAgentEnabledByAgency",
  "webChatEnabledByAgency",
  "inboundVoiceEnabledByAgency",
]);

function defaultGates(): PlanGates {
  const gates = {} as PlanGates;
  for (const key of PLAN_GATE_KEYS) {
    gates[key] = DEFAULT_ON_PLAN_GATES.has(key);
  }
  return gates;
}

interface Props {
  /** null = create mode. */
  plan: BillingPlanResponse | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

export function PlanEditorDialog({ plan, open, onOpenChange, onSaved }: Props) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [priceDollars, setPriceDollars] = useState("");
  const [annualPriceDollars, setAnnualPriceDollars] = useState("");
  const [currency, setCurrency] = useState<string>("usd");
  const [gates, setGates] = useState<PlanGates>(defaultGates);
  // Included monthly quotas. Blank = unlimited.
  const [quotaInputs, setQuotaInputs] = useState<Record<string, string>>({});
  // Overage rates, typed in dollars per unit, stored in cents.
  const [rateInputs, setRateInputs] = useState<Record<string, string>>({});
  // Spend ceiling and flat monthly fees, typed in dollars.
  const [capInput, setCapInput] = useState("");
  const [feeInputs, setFeeInputs] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<"plan" | "features" | "usage">("plan");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTab("plan");
    setName(plan?.name ?? "");
    setDescription(plan?.description ?? "");
    setPriceDollars(
      plan ? (plan.priceMonthlyCents / 100).toFixed(2).replace(/\.00$/, "") : "",
    );
    setAnnualPriceDollars(
      plan?.priceAnnualCents != null
        ? (plan.priceAnnualCents / 100).toFixed(2).replace(/\.00$/, "")
        : "",
    );
    setCurrency(plan?.currency ?? "usd");
    setGates(plan ? { ...plan.gates } : defaultGates());
    const q = plan?.quotas ?? null;
    const r = plan?.rates ?? null;
    const inc: Record<string, string> = {};
    const rt: Record<string, string> = {};
    for (const u of USAGE_UNIT_META) {
      const v = q?.[u.quotaKey];
      inc[u.quotaKey] = typeof v === "number" ? String(v) : "";
      if (u.rateKey) rt[u.rateKey] = centsToDollars(r?.[u.rateKey]);
    }
    setQuotaInputs(inc);
    setRateInputs(rt);
    setCapInput(centsToDollars(plan?.spendCapCents ?? null));
    const fees: Record<string, string> = {};
    for (const k of FEE_GATE_KEYS) fees[k] = centsToDollars(plan?.featureFees?.[k]?.cents);
    setFeeInputs(fees);
  }, [open, plan]);

  // Blank/invalid inputs drop out; nothing valid = null (unlimited).
  const quotasPayload = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [key, raw] of Object.entries(quotaInputs)) {
      const n = Number.parseInt(raw.trim(), 10);
      // 0 is a real allowance: with a rate it means pay as you go.
      if (Number.isFinite(n) && n >= 0) out[key] = n;
    }
    return Object.keys(out).length > 0 ? out : null;
  }, [quotaInputs]);

  // Dollars typed, integer cents sent.
  const ratesPayload = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [key, raw] of Object.entries(rateInputs)) {
      const n = Number.parseFloat(raw.trim());
      if (Number.isFinite(n) && n > 0) out[key] = Math.round(n * 100);
    }
    return Object.keys(out).length > 0 ? out : null;
  }, [rateInputs]);

  const spendCapCents = dollarsToCents(capInput) ?? null;

  // Fees for gates this plan includes, plus the standalone gates a client may have.
  const feeKeys = useMemo(
    () =>
      FEE_GATE_KEYS.filter(
        (k) => !(PLAN_GATE_KEYS as readonly string[]).includes(k) || gates[k as keyof PlanGates],
      ),
    [gates],
  );
  const featureFeesPayload = useMemo(() => {
    const out: Record<string, { label: string; cents: number }> = {};
    // Only fees whose input is visible, so unticking a gate drops its fee too.
    for (const k of feeKeys) {
      const c = dollarsToCents(feeInputs[k] ?? "");
      if (c) out[k] = { label: FEE_GATE_LABELS[k as FeeGateKey], cents: c };
    }
    return Object.keys(out).length > 0 ? out : null;
  }, [feeInputs, feeKeys]);

  const priceCents = useMemo(() => {
    const parsed = Number.parseFloat(priceDollars);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return Math.round(parsed * 100);
  }, [priceDollars]);

  // Optional annual price; blank = monthly only. Non-positive counts as blank so
  // a stray keystroke doesn't block saving.
  const annualPriceCents = useMemo(() => {
    const trimmed = annualPriceDollars.trim();
    if (!trimmed) return null;
    const parsed = Number.parseFloat(trimmed);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return Math.round(parsed * 100);
  }, [annualPriceDollars]);

  const gateCount = PLAN_GATE_KEYS.filter((k) => gates[k]).length;
  const quotaCount = quotasPayload ? Object.keys(quotasPayload).length : 0;
  const canSave = !!name.trim() && priceCents !== null && !saving;

  async function handleSave() {
    if (!canSave || priceCents === null) return;
    setSaving(true);
    try {
      const body = plan
        ? {
            name: name.trim(),
            description: description.trim() || null,
            priceMonthlyCents: priceCents,
            // null removes annual; a number sets/changes it.
            priceAnnualCents: annualPriceCents,
            gates,
            quotas: quotasPayload,
            rates: ratesPayload,
            spendCapCents,
            featureFees: featureFeesPayload,
          }
        : {
            name: name.trim(),
            description: description.trim() || null,
            priceMonthlyCents: priceCents,
            priceAnnualCents: annualPriceCents,
            currency,
            gates,
            quotas: quotasPayload,
            rates: ratesPayload,
            spendCapCents,
            featureFees: featureFeesPayload,
          };
      const res = await fetch(
        plan ? `/api/agency/plans/${plan.id}` : "/api/agency/plans",
        {
          method: plan ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to save the plan.");
      toast.success(plan ? "Plan updated." : "Plan created.");
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save the plan.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Wide dialog with a fixed-height tabbed body; normal scrolling on mobile. */}
      <DialogContent className="flex max-h-[90vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl">
        <DialogHeader className="border-b px-6 pb-4 pt-5">
          <DialogTitle>{plan ? `Edit ${plan.name}` : "New plan"}</DialogTitle>
          <DialogDescription>
            A plan bundles a price, the features it unlocks, and the usage it
            includes. Assign it from Sub-accounts → Manage → Billing.
          </DialogDescription>
        </DialogHeader>

        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as typeof tab)}
          className="min-h-0 flex-1 gap-0"
        >
          <div className="border-b px-6 py-2.5">
            <TabsList className="w-full sm:w-auto">
              <TabsTrigger value="plan" className="px-4">
                Plan &amp; pricing
              </TabsTrigger>
              <TabsTrigger value="features" className="px-4">
                Features
                <span className="rounded-full bg-muted-foreground/15 px-1.5 text-[10px] tabular-nums">
                  {gateCount}
                </span>
              </TabsTrigger>
              <TabsTrigger value="usage" className="px-4">
                Usage &amp; rates
                {quotaCount > 0 && (
                  <span className="rounded-full bg-muted-foreground/15 px-1.5 text-[10px] tabular-nums">
                    {quotaCount}
                  </span>
                )}
              </TabsTrigger>
            </TabsList>
          </div>

          {/* Fixed height, sized to the tallest tab, so switching never resizes the
              dialog. Overflow scrolls inside; min() guards tiny phones. */}
          <div className="h-[min(340px,60dvh)] min-h-0 overflow-y-auto px-6 py-5">
            {/* Tab 1: identity + pricing */}
            <TabsContent value="plan">
              <div className="grid gap-6 sm:grid-cols-2">
                <div className="space-y-4">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">
                      Plan name
                    </label>
                    <Input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="e.g. Pro"
                      maxLength={60}
                      disabled={saving}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">
                      Description (optional)
                    </label>
                    <Input
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder="Everything in Starter plus broadcasts + workflows"
                      maxLength={300}
                      disabled={saving}
                    />
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Shown to you in plan lists — clients never see it.
                    </p>
                  </div>
                </div>
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-muted-foreground">
                        Monthly price
                      </label>
                      <Input
                        value={priceDollars}
                        onChange={(e) => setPriceDollars(e.target.value)}
                        placeholder="297"
                        inputMode="decimal"
                        disabled={saving}
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-muted-foreground">
                        Currency{plan ? " (fixed)" : ""}
                      </label>
                      <select
                        value={currency}
                        onChange={(e) => setCurrency(e.target.value)}
                        disabled={saving || !!plan}
                        className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 [&_option]:bg-background [&_option]:text-foreground"
                      >
                        {CURRENCIES.map((c) => (
                          <option key={c} value={c}>
                            {c.toUpperCase()}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">
                      Annual price (optional)
                    </label>
                    <Input
                      value={annualPriceDollars}
                      onChange={(e) => setAnnualPriceDollars(e.target.value)}
                      placeholder="e.g. 2970"
                      inputMode="decimal"
                      disabled={saving}
                    />
                    <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                      Blank = monthly-only. You set the annual amount directly
                      (e.g. 10× monthly = &ldquo;2 months free&rdquo;); you pick
                      monthly or annual when assigning the plan to a client.
                      {plan &&
                        " Price changes only affect new checkouts — existing subscribers keep their current price."}
                    </p>
                  </div>
                </div>
              </div>
            </TabsContent>

            {/* Tab 2: feature gates */}
            <TabsContent value="features">
              <div className="grid gap-1.5 sm:grid-cols-3">
                {PLAN_GATE_KEYS.map((key) => (
                  <label
                    key={key}
                    className="flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-2 text-sm transition-colors hover:bg-muted/40"
                  >
                    <input
                      type="checkbox"
                      checked={gates[key]}
                      onChange={(e) =>
                        setGates((prev) => ({
                          ...prev,
                          [key]: e.target.checked,
                        }))
                      }
                      disabled={saving}
                      className="h-4 w-4 cursor-pointer"
                    />
                    <span className="min-w-0 truncate">
                      {PLAN_GATE_LABELS[key]}
                    </span>
                  </label>
                ))}
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                Core CRM (contacts, pipeline, calendar, tasks, forms, quotes) is
                always included. Gate changes re-apply automatically to every
                client currently on this plan.
              </p>
            </TabsContent>

            {/* Tab 3: allowances + overage rates */}
            <TabsContent value="usage">
              <div className="grid items-center gap-x-3 gap-y-2 sm:grid-cols-[1.1fr_1fr_1fr]">
                <span className="hidden text-[11px] font-medium uppercase tracking-wide text-muted-foreground sm:block">
                  Unit
                </span>
                <span className="hidden text-[11px] font-medium uppercase tracking-wide text-muted-foreground sm:block">
                  Included / month
                </span>
                <span className="hidden text-[11px] font-medium uppercase tracking-wide text-muted-foreground sm:block">
                  Rate ({currency.toUpperCase()})
                </span>
                {USAGE_UNIT_META.map((u) => (
                  <div key={u.quotaKey} className="contents">
                    <span className="pt-2 text-sm sm:pt-0">{u.label}</span>
                    <Input
                      type="number"
                      min={0}
                      inputMode="numeric"
                      aria-label={`${u.label} included per month`}
                      value={quotaInputs[u.quotaKey] ?? ""}
                      onChange={(e) =>
                        setQuotaInputs((prev) => ({
                          ...prev,
                          [u.quotaKey]: e.target.value,
                        }))
                      }
                      placeholder="None"
                      disabled={saving}
                    />
                    {u.rateKey ? (
                      <Input
                        type="number"
                        min={0.01}
                        step={0.01}
                        inputMode="decimal"
                        aria-label={`${u.label} rate in dollars ${u.per}`}
                        value={rateInputs[u.rateKey] ?? ""}
                        onChange={(e) =>
                          setRateInputs((prev) => ({
                            ...prev,
                            [u.rateKey!]: e.target.value,
                          }))
                        }
                        placeholder={u.per}
                        disabled={saving}
                      />
                    ) : (
                      <span className="text-xs text-muted-foreground">{u.capOnlyReason}</span>
                    )}
                  </div>
                ))}
              </div>
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                Rates only bill clients you rebill (Client billing → Usage
                rebilling, then each client&apos;s Billing &amp; usage tab), on
                the 1st for the month before. With a rate, usage continues past
                the included amount (blank or 0 = billed from the first unit);
                without one, the included amount is a hard cap (blank =
                unlimited) and you&apos;re emailed at 80% and 100%. A client&apos;s
                own Twilio is never metered. Rates are in whole cents. Per-client overrides live in the
                Manage panel.
              </p>

              <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">
                  Spend ceiling ({currency.toUpperCase()} / month)
                </span>
                <Input
                  type="number"
                  min={1}
                  step={1}
                  inputMode="decimal"
                  className="w-32"
                  value={capInput}
                  placeholder="None"
                  disabled={saving}
                  onChange={(e) => setCapInput(e.target.value)}
                  aria-label="Monthly spend ceiling in dollars"
                />
                <span className="text-xs text-muted-foreground">
                  Priced channels pause once a client&apos;s billable usage reaches it.
                </span>
              </div>

              <div className="mt-4">
                <p className="text-sm font-medium">
                  Flat monthly fees ({currency.toUpperCase()})
                </p>
                <p className="mb-2 text-xs text-muted-foreground">
                  e.g. AI Agent 50/mo. Billed for any month the feature is on,
                  even when the client uses their own provider. All amounts on
                  this tab are in the plan&apos;s currency.
                </p>
                <div className="grid items-center gap-x-3 gap-y-1.5 sm:grid-cols-[1.6fr_1fr]">
                  {feeKeys.map((k) => (
                    <div key={k} className="contents">
                      <span className="text-sm">{FEE_GATE_LABELS[k]}</span>
                      <Input
                        type="number"
                        min={0.5}
                        step={1}
                        inputMode="decimal"
                        value={feeInputs[k] ?? ""}
                        placeholder="No fee"
                        disabled={saving}
                        onChange={(e) =>
                          setFeeInputs((prev) => ({ ...prev, [k]: e.target.value }))
                        }
                        aria-label={`${FEE_GATE_LABELS[k]} monthly fee in dollars`}
                      />
                    </div>
                  ))}
                </div>
              </div>
            </TabsContent>
          </div>
        </Tabs>

        <DialogFooter className="flex-row items-center gap-3 border-t px-6 py-4 sm:justify-between">
          <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {canSave || saving ? (
              <>
                <span className="font-medium text-foreground">
                  {name.trim() || "Untitled"}
                </span>
                {" · "}
                {priceDollars ? `$${priceDollars}/mo` : "—"}
                {annualPriceDollars ? ` · $${annualPriceDollars}/yr` : ""}
                {" · "}
                {gateCount} features
                {quotaCount > 0 ? ` · ${quotaCount} usage limits` : ""}
              </>
            ) : (
              "A name and monthly price are required (Plan & pricing tab)."
            )}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button size="sm" onClick={handleSave} disabled={!canSave}>
              {saving ? (
                <>
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  Saving…
                </>
              ) : plan ? (
                "Save changes"
              ) : (
                "Create plan"
              )}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
