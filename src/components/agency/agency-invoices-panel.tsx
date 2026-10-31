"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Copy, Loader2, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatBillingPrice } from "@/lib/billing/status";
import type { BillingChargeResponse } from "@/types/billing";
import type { SubAccountDoc } from "@/types";

/** Agency > Client billing > Invoices: one-time and usage charges across every client. */

type Filter = "all" | "outstanding" | "overdue" | "paid" | "canceled";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "outstanding", label: "Outstanding" },
  { id: "overdue", label: "Overdue" },
  { id: "paid", label: "Paid" },
  { id: "canceled", label: "Canceled / waived" },
];

// Same rule as the server's overdue flag: past the due day (UTC), not on it.
function isOverdue(c: BillingChargeResponse, today: string): boolean {
  return c.status === "pending" && !!c.dueAt && c.dueAt.slice(0, 10) < today;
}

function matches(c: BillingChargeResponse, f: Filter, today: string): boolean {
  if (f === "all") return true;
  if (f === "outstanding") return c.status === "pending";
  if (f === "overdue") return isOverdue(c, today);
  return c.status === f;
}

function shortDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

// Totals stay per currency; adding USD to AUD would be meaningless.
function sumByCurrency(list: BillingChargeResponse[]): string {
  const by = new Map<string, number>();
  for (const c of list)
    by.set(c.currency, (by.get(c.currency) ?? 0) + c.amountCents);
  if (by.size === 0) return formatBillingPrice(0, "usd");
  return [...by.entries()]
    .map(
      ([cur, cents]) =>
        `${formatBillingPrice(cents, cur)} ${cur.toUpperCase()}`,
    )
    .join(" + ");
}

export function AgencyInvoicesPanel({ subs }: { subs: SubAccountDoc[] }) {
  const [charges, setCharges] = useState<BillingChargeResponse[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const r = await fetch("/api/agency/billing/charges");
      if (!r.ok) throw new Error(String(r.status));
      const d = (await r.json()) as { charges?: BillingChargeResponse[] };
      setCharges(d.charges ?? []);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const names = useMemo(() => new Map(subs.map((s) => [s.id, s.name])), [subs]);
  const today = new Date().toISOString().slice(0, 10);
  const thisMonth = today.slice(0, 7);

  const totals = useMemo(() => {
    const list = charges ?? [];
    return {
      outstanding: sumByCurrency(list.filter((c) => c.status === "pending")),
      overdue: sumByCurrency(list.filter((c) => isOverdue(c, today))),
      collected: sumByCurrency(
        list.filter(
          (c) => c.status === "paid" && c.paidAt?.slice(0, 7) === thisMonth,
        ),
      ),
    };
  }, [charges, today, thisMonth]);

  const counts = useMemo(() => {
    const out = {} as Record<Filter, number>;
    for (const f of FILTERS)
      out[f.id] = (charges ?? []).filter((c) => matches(c, f.id, today)).length;
    return out;
  }, [charges, today]);

  const visible = (charges ?? []).filter((c) => matches(c, filter, today));

  async function copyLink(c: BillingChargeResponse) {
    if (
      c.kind === "usage" &&
      !window.confirm(
        "Copy a new payment link? The link in the invoice email stops working; reminders use the new one.",
      )
    ) {
      return;
    }
    setBusyId(c.id);
    try {
      const res = await fetch(
        `/api/agency/sub-accounts/${c.subAccountId}/billing/charges/${c.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "sendLink" }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        checkoutUrl?: string;
      };
      if (!res.ok || !data.checkoutUrl)
        throw new Error(data.error ?? "Failed to mint a link.");
      await navigator.clipboard
        .writeText(data.checkoutUrl)
        .catch(() => undefined);
      toast.success("Fresh payment link copied. Older links no longer work.");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to mint a link.",
      );
    } finally {
      setBusyId(null);
    }
  }

  async function cancel(c: BillingChargeResponse) {
    const usage = c.kind === "usage";
    const question = usage
      ? "Waive this usage charge? The client won't be asked to pay it, and any overdue banner or paywall it caused lifts."
      : "Cancel this charge? Its payment link goes dead immediately.";
    if (!window.confirm(question)) return;
    setBusyId(c.id);
    try {
      const res = await fetch(
        `/api/agency/sub-accounts/${c.subAccountId}/billing/charges/${c.id}`,
        {
          method: "DELETE",
        },
      );
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to cancel.");
      toast.success(usage ? "Usage charge waived." : "Charge canceled.");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to cancel.");
    } finally {
      setBusyId(null);
    }
  }

  if (failed) {
    return (
      <div className="bg-card text-muted-foreground rounded-2xl border p-8 text-center text-sm">
        Couldn&apos;t load invoices.{" "}
        <button
          type="button"
          className="text-primary hover:underline"
          onClick={() => void load()}
        >
          Try again
        </button>
      </div>
    );
  }
  if (!charges)
    return <div className="bg-muted/50 h-40 animate-pulse rounded-2xl" />;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Outstanding" value={totals.outstanding} />
        <Stat
          label="Overdue"
          value={totals.overdue}
          tone={counts.overdue > 0 ? "bad" : undefined}
        />
        <Stat label="Collected this month" value={totals.collected} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              className={
                "rounded-full border px-3 py-1 text-xs transition-colors " +
                (filter === f.id
                  ? "border-foreground/30 bg-muted text-foreground font-medium"
                  : "text-muted-foreground hover:text-foreground")
              }
            >
              {f.label} <span className="tabular-nums">{counts[f.id]}</span>
            </button>
          ))}
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 text-xs"
          onClick={() => void load()}
        >
          <RefreshCw className="mr-1 h-3 w-3" />
          Refresh
        </Button>
      </div>

      <div className="bg-card overflow-x-auto rounded-2xl border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-muted-foreground text-xs tracking-wide uppercase">
            <tr>
              <th className="px-4 py-2.5 text-left font-medium">Issued</th>
              <th className="px-4 py-2.5 text-left font-medium">Client</th>
              <th className="px-4 py-2.5 text-left font-medium">What for</th>
              <th className="px-4 py-2.5 text-right font-medium">Amount</th>
              <th className="px-4 py-2.5 text-left font-medium">Due</th>
              <th className="px-4 py-2.5 text-left font-medium">Status</th>
              <th className="px-4 py-2.5"></th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="text-muted-foreground px-4 py-12 text-center"
                >
                  {charges.length === 0
                    ? "No invoices yet. One-time charges and monthly usage charges appear here once issued."
                    : "Nothing matches this filter."}
                </td>
              </tr>
            ) : (
              visible.map((c) => {
                const usage = c.kind === "usage";
                const overdue = isOverdue(c, today);
                const label =
                  c.status === "paid"
                    ? "Paid"
                    : c.status === "canceled"
                      ? usage
                        ? "Waived"
                        : "Canceled"
                      : overdue
                        ? "Overdue"
                        : "Pending";
                return (
                  <tr key={c.id} className="border-t">
                    <td className="text-muted-foreground px-4 py-3 whitespace-nowrap">
                      {shortDate(c.createdAt)}
                    </td>
                    <td className="px-4 py-3 font-medium">
                      {names.get(c.subAccountId) ?? "Deleted client"}
                    </td>
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-1.5">
                        {usage && (
                          <span className="shrink-0 rounded-full bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-sky-600 uppercase dark:text-sky-400">
                            Usage
                          </span>
                        )}
                        <span className="min-w-0 truncate">
                          {c.description}
                        </span>
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap tabular-nums">
                      {formatBillingPrice(c.amountCents, c.currency)}{" "}
                      <span className="text-muted-foreground text-xs">
                        {c.currency.toUpperCase()}
                      </span>
                    </td>
                    <td className="text-muted-foreground px-4 py-3 whitespace-nowrap">
                      {shortDate(c.dueAt)}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span
                        className={
                          "rounded-full px-2 py-0.5 text-[11px] font-medium " +
                          (c.status === "paid"
                            ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                            : c.status === "canceled"
                              ? "bg-muted text-muted-foreground"
                              : overdue
                                ? "bg-rose-500/10 text-rose-600 dark:text-rose-400"
                                : "bg-amber-500/10 text-amber-600 dark:text-amber-400")
                        }
                      >
                        {label}
                      </span>
                      {c.status === "paid" && c.paidAt && (
                        <span className="text-muted-foreground ml-1.5 text-xs">
                          {shortDate(c.paidAt)}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      {c.status === "pending" && (
                        <span className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => void copyLink(c)}
                            disabled={busyId !== null}
                            title="Copy a fresh payment link"
                            aria-label="Copy a fresh payment link"
                            className="text-muted-foreground hover:text-foreground rounded p-1 transition-colors disabled:opacity-50"
                          >
                            {busyId === c.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Copy className="h-3.5 w-3.5" />
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => void cancel(c)}
                            disabled={busyId !== null}
                            title={
                              usage
                                ? "Waive this usage charge"
                                : "Cancel this charge"
                            }
                            aria-label={
                              usage
                                ? "Waive this usage charge"
                                : "Cancel this charge"
                            }
                            className="text-muted-foreground hover:text-destructive rounded p-1 transition-colors disabled:opacity-50"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <p className="text-muted-foreground text-xs">
        One-time charges and monthly usage charges. Plan subscription payments,
        refunds and payouts are in your{" "}
        <a
          href="https://dashboard.stripe.com"
          target="_blank"
          rel="noreferrer"
          className="text-primary hover:underline"
        >
          Stripe dashboard
        </a>
        .
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "bad";
}) {
  return (
    <div className="bg-card rounded-2xl border p-4">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p
        className={
          "mt-1 text-lg font-semibold tabular-nums " +
          (tone === "bad" ? "text-rose-600 dark:text-rose-400" : "")
        }
      >
        {value}
      </p>
    </div>
  );
}
