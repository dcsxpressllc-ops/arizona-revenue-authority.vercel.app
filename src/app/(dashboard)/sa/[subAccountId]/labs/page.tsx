"use client";

import { FlaskConical, Lock } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { FunnelsSection } from "@/components/labs/funnels-section";

/**
 * Labs: container for experimental features, gated by `labsEnabledByAgency`
 * (off by default). Each experiment keeps its own safeguards on top of this
 * gate. Kept as a thin shell so adding or removing an experiment is one card;
 * proven experiments graduate into the main menu (the inbox watchdog now
 * lives under AI Agents → Monitors).
 */
export default function LabsPage() {
  const { subAccount } = useSubAccount();
  const labsEnabled = subAccount?.labsEnabledByAgency === true;

  if (!labsEnabled) {
    return (
      <div className="mx-auto w-full max-w-3xl">
        <section className="rounded-2xl border bg-card p-6">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <Lock className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-base font-semibold">Labs</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Labs is locked for this sub-account. Your agency controls
                access to pre-release features — ask your agency owner to
                enable Labs from the sub-account&apos;s Manage panel.
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
        <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-lime-500/15 via-emerald-500/15 to-teal-500/15 text-lime-600 dark:text-lime-400">
          <FlaskConical className="h-6 w-6" />
        </span>
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            Labs
            <span className="rounded-full bg-lime-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-lime-600 dark:text-lime-400">
              Pre-release
            </span>
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Early access to features still in development. Everything here is
            experimental — it may change, move, or be withdrawn as it matures.
            Proven features graduate into the main menu.
          </p>
        </div>
      </header>

      <section className="space-y-4">
        {/* Quick Funnels */}
        <FunnelsSection />

        <p className="text-xs text-muted-foreground">
          Have an idea for an experiment? Tell your agency — Labs is where new
          functionality lands first.
        </p>
      </section>
    </div>
  );
}
