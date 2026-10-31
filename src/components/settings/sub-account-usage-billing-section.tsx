"use client";

import { useCallback, useEffect, useState } from "react";
import { usePayUsageCharge } from "@/hooks/use-pay-usage-charge";
import { ChevronDown, ChevronRight, CreditCard, Gauge, Loader2, Receipt } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatBillingPrice } from "@/lib/billing/status";
import { formatUsageMonth, USAGE_PAYMENT_TERMS_DAYS } from "@/lib/billing/usage";
import type { ClientUsageResponse } from "@/types/usage-billing";

/** Loads the client usage view; null while loading or when not allowed. */
export function useClientUsage(subAccountId: string | null, enabled: boolean) {
  const [data, setData] = useState<ClientUsageResponse | null>(null);
  const load = useCallback(async () => {
    if (!subAccountId || !enabled) return;
    try {
      const r = await fetch(`/api/sub-accounts/${subAccountId}/usage`);
      if (!r.ok) return;
      setData((await r.json()) as ClientUsageResponse);
    } catch {
      // Tab stays hidden.
    }
  }, [subAccountId, enabled]);
  useEffect(() => {
    setData(null);
    void load();
  }, [load]);
  return data;
}

function unitText(minutes: boolean, n: number): string {
  return minutes ? `${Math.round(n / 60).toLocaleString()} min` : n.toLocaleString();
}

export function SubAccountUsageBillingSection({
  subAccountId,
  data,
}: {
  subAccountId: string;
  data: ClientUsageResponse;
}) {
  const money = (c: number, cur = data.currency) => formatBillingPrice(c, cur);
  const { paying, pay } = usePayUsageCharge(subAccountId);
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      {data.rebilled && (
        <section className="rounded-2xl border bg-card p-5">
          <div className="flex items-center gap-2">
            <Gauge className="h-4 w-4 text-muted-foreground" />
            <h2 className="font-semibold">Usage — {formatUsageMonth(data.month)}</h2>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Usage past what your plan includes is billed on the 1st for the month
            before, payable within {USAGE_PAYMENT_TERMS_DAYS} days. Your card isn&apos;t
            saved; each month you pay by link.
          </p>

          {data.units.length > 0 && (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="py-1 pr-3 font-normal">Service</th>
                    <th className="py-1 pr-3 font-normal">Used</th>
                    <th className="py-1 pr-3 font-normal">Included</th>
                    <th className="py-1 pr-3 font-normal">Rate</th>
                    <th className="py-1 text-right font-normal">So far</th>
                  </tr>
                </thead>
                <tbody>
                  {data.units.map((u) => (
                    <tr key={u.label} className="border-t">
                      <td className="py-1.5 pr-3">{u.label}</td>
                      <td className="py-1.5 pr-3 tabular-nums">{unitText(u.minutes, u.used)}</td>
                      <td className="py-1.5 pr-3 tabular-nums">
                        {u.included > 0 ? unitText(u.minutes, u.included) : "—"}
                      </td>
                      <td className="py-1.5 pr-3 tabular-nums">
                        {money(u.rateCents)}
                        <span className="text-xs text-muted-foreground">
                          {u.minutes ? " / min" : " each"}
                        </span>
                      </td>
                      <td className="py-1.5 text-right font-medium tabular-nums">{money(u.cents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {data.fees.length > 0 && (
            <ul className="mt-3 space-y-1 text-sm">
              {data.fees.map((f) => (
                <li key={f.label} className="flex justify-between">
                  <span>
                    {f.label} <span className="text-xs text-muted-foreground">monthly fee</span>
                  </span>
                  <span className="tabular-nums">{money(f.cents)}</span>
                </li>
              ))}
            </ul>
          )}
          {data.carriedInCents > 0 && (
            <p className="mt-2 flex justify-between text-sm">
              <span>Carried from last month</span>
              <span className="tabular-nums">{money(data.carriedInCents)}</span>
            </p>
          )}

          <div className="mt-3 flex items-baseline justify-between border-t pt-3">
            <span className="text-sm font-medium">Estimated usage charge so far</span>
            <span className="text-lg font-semibold tabular-nums">{money(data.estimatedCents)}</span>
          </div>
          {data.spendCap && data.units.length > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              Usage spending limit: {money(data.spendCap.usedCents)} of {money(data.spendCap.cents)}{" "}
              used this month (monthly fees not counted).
              {data.spendCap.usedCents >= data.spendCap.cents
                ? " Paid services are paused until next month."
                : " Paid services pause if usage reaches it."}
            </p>
          )}
        </section>
      )}

      {data.charges.length > 0 && (
        <section className="rounded-2xl border bg-card p-5">
          <div className="flex items-center gap-2">
            <Receipt className="h-4 w-4 text-muted-foreground" />
            <h2 className="font-semibold">Usage charges</h2>
          </div>
          <ul className="mt-3 divide-y">
            {data.charges.map((c) => {
              const overdue =
                c.status === "pending" &&
                c.dueAt !== null &&
                new Date(c.dueAt).toISOString().slice(0, 10) < new Date().toISOString().slice(0, 10);
              const expanded = openId === c.id;
              return (
                <li key={c.id} className="py-2.5">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-1.5 text-left disabled:cursor-default"
                      onClick={() => setOpenId(expanded ? null : c.id)}
                      aria-expanded={expanded}
                      disabled={c.lineItems.length === 0}
                    >
                      {c.lineItems.length === 0 ? null : expanded ? (
                        <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                      )}
                      <span className="truncate">
                        {c.month ? formatUsageMonth(c.month) : "Usage"}
                      </span>
                    </button>
                    <span
                      className={
                        "rounded-full px-2 py-0.5 text-[11px] font-medium " +
                        (c.status === "paid"
                          ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                          : overdue
                            ? "bg-rose-500/10 text-rose-600 dark:text-rose-400"
                            : "bg-amber-500/10 text-amber-600 dark:text-amber-400")
                      }
                    >
                      {c.status === "paid" ? "Paid" : overdue ? "Overdue" : "Due"}
                      {c.status === "pending" && c.dueAt
                        ? ` ${new Date(c.dueAt).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })}`
                        : ""}
                    </span>
                    <span className="font-medium tabular-nums">{money(c.amountCents, c.currency)}</span>
                    {c.status === "pending" && (
                      <Button
                        type="button"
                        size="sm"
                        className="h-7 px-3 text-xs"
                        disabled={paying !== null}
                        onClick={() => pay(c.id)}
                      >
                        {paying === c.id ? (
                          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                        ) : (
                          <CreditCard className="mr-1 h-3 w-3" />
                        )}
                        Pay
                      </Button>
                    )}
                  </div>
                  {expanded && c.lineItems.length > 0 && (
                    <ul className="mt-2 space-y-1 pl-5 text-xs text-muted-foreground">
                      {c.lineItems.map((l, i) => (
                        <li key={i} className="flex justify-between gap-3">
                          <span>
                            {l.label}
                            {l.detail ? ` (${l.detail})` : ""}
                          </span>
                          <span className="tabular-nums">{money(l.amountCents, c.currency)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
