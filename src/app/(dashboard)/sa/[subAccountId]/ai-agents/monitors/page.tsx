"use client";

import { Lock, Radar } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { WatchdogSection } from "@/components/ai-agents/monitors/watchdog-section";
import { StaleDealsSection } from "@/components/ai-agents/monitors/stale-deals-section";

/**
 * AI Agents → Monitors: background agents that watch the workspace and only
 * ever add a Task, a push and an activity row. Gated by `agentsEnabledByAgency`
 * (off by default; every judgment spends the agency's AI credits).
 */
export default function MonitorsPage() {
  const { subAccount } = useSubAccount();
  const gateOn = subAccount?.agentsEnabledByAgency === true;

  if (!gateOn) {
    return (
      <div className="mx-auto w-full max-w-3xl">
        <section className="rounded-2xl border bg-card p-6">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <Lock className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-base font-semibold">Monitors</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Agent monitors are locked for this sub-account. They spend your
                agency&apos;s AI credits, so your agency owner switches them on
                from the sub-account&apos;s Manage panel.
              </p>
            </div>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <header className="flex items-start gap-4">
        <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500/15 via-teal-500/15 to-cyan-500/15 text-emerald-600 dark:text-emerald-400">
          <Radar className="h-6 w-6" />
        </span>
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            Monitors
            <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
              Beta
            </span>
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Agents that watch the workspace every hour and raise a hand when
            something is slipping. They only ever add a task, a push and a note
            on the contact — never a message to a customer, never a change to a
            record.
          </p>
        </div>
      </header>

      <section className="space-y-4">
        <WatchdogSection />
        <StaleDealsSection />
      </section>
    </div>
  );
}
