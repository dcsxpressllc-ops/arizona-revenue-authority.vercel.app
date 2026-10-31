"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Check,
  Circle,
  CircleAlert,
  KeyRound,
  TriangleAlert,
} from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { getUserDoc, updateUserDoc } from "@/lib/firestore/users";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

/**
 * Ten seconds after login, shows the agency owner which integrations are
 * configured, with a link to Guided setup. Shown only when: the caller is the
 * owner, they haven't ticked "Don't show again" (stored on users/{uid}), it
 * hasn't shown this browser session, and the summary endpoint answered.
 * Uses the same /api/agency/setup/summary as the Get-started banner.
 */

const OPEN_DELAY_MS = 10_000;
const SESSION_KEY = "setup-snapshot-shown";

type GroupStatus = "ok" | "check" | "off" | "error";

interface SnapshotGroup {
  title: string;
  tier: string;
  status: GroupStatus;
  off: string | null;
}

interface SetupSummary {
  ok: boolean;
  requiredComplete: boolean;
  featuresConfigured: number;
  featuresTotal: number;
  groups: SnapshotGroup[];
}

/**
 * Integrations new owners actually ask about, in priority order. The rest fold
 * into "N more" so this stays a snapshot.
 */
const HEADLINE_TITLES = [
  "Email (Resend)",
  "SMS (Twilio)",
  "AI replies (OpenRouter)",
  "AI Voice (Vapi)",
  "Automations + secure links (QStash)",
  "Billing (Stripe)",
  "Push notifications (PWA)",
  "Website builder (gitpage)",
  "Facebook + Instagram (Meta)",
  "Google Calendar sync",
];

/** Shorter row labels (catalog titles include vendor names). */
function shortLabel(title: string): string {
  switch (title) {
    case "Email (Resend)":
      return "Email";
    case "SMS (Twilio)":
      return "SMS & WhatsApp number";
    case "AI replies (OpenRouter)":
      return "AI agents & assistants";
    case "AI Voice (Vapi)":
      return "AI voice agent";
    case "Automations + secure links (QStash)":
      return "Workflows & scheduled steps";
    case "Billing (Stripe)":
      return "Client billing (Stripe)";
    case "Push notifications (PWA)":
      return "Mobile app push alerts";
    case "Website builder (gitpage)":
      return "Website builder";
    case "Facebook + Instagram (Meta)":
      return "Facebook & Instagram";
    default:
      return title;
  }
}

function StatusIcon({ status }: { status: GroupStatus }) {
  if (status === "ok") {
    return (
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
        <Check className="h-3.5 w-3.5" />
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-rose-500/10 text-rose-600 dark:text-rose-400">
        <TriangleAlert className="h-3.5 w-3.5" />
      </span>
    );
  }
  if (status === "check") {
    return (
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400">
        <CircleAlert className="h-3.5 w-3.5" />
      </span>
    );
  }
  return (
    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
      <Circle className="h-3 w-3" />
    </span>
  );
}

function statusWord(status: GroupStatus): string {
  switch (status) {
    case "ok":
      return "Configured";
    case "check":
      return "Needs a check";
    case "error":
      return "Missing required keys";
    default:
      return "Not set up";
  }
}

export function SetupSnapshotDialog() {
  const { user, loading, agencyRole } = useAuth();
  const [summary, setSummary] = useState<SetupSummary | null>(null);
  const [open, setOpen] = useState(false);
  const [dontShowAgain, setDontShowAgain] = useState(false);

  const isOwner = !loading && !!user && agencyRole === "owner";

  useEffect(() => {
    if (!isOwner || !user) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    // Once per browser session; route changes must not re-open it.
    try {
      if (sessionStorage.getItem(SESSION_KEY) === "1") return;
    } catch {
      // Storage unavailable (private mode): show once.
    }

    void (async () => {
      // Per-user "don't show again" lives on their own users/{uid} doc.
      try {
        const doc = await getUserDoc(user.uid);
        if (cancelled || doc?.setupSnapshotDismissed === true) return;
      } catch {
        // Unreadable user doc; don't risk showing it.
        return;
      }
      let data: SetupSummary | null = null;
      try {
        const r = await fetch("/api/agency/setup/summary");
        data = r.ok ? ((await r.json()) as SetupSummary) : null;
      } catch {
        data = null;
      }
      if (cancelled || !data?.ok || !Array.isArray(data.groups)) return;
      setSummary(data);
      timer = setTimeout(() => {
        if (cancelled) return;
        setOpen(true);
        try {
          sessionStorage.setItem(SESSION_KEY, "1");
        } catch {
          // Shown once for this render at least.
        }
      }, OPEN_DELAY_MS);
    })();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [isOwner, user]);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next && dontShowAgain && user) {
      void updateUserDoc(user.uid, { setupSnapshotDismissed: true }).catch(
        () => {
          // Best effort; the session flag still stops a re-open now.
        },
      );
    }
  }

  if (!summary) return null;

  const byTitle = new Map(summary.groups.map((g) => [g.title, g]));
  const headline = HEADLINE_TITLES.map((t) => byTitle.get(t)).filter(
    (g): g is SnapshotGroup => !!g,
  );
  const rest = summary.groups.filter(
    (g) => !HEADLINE_TITLES.includes(g.title) && g.tier === "feature",
  );
  const restConfigured = rest.filter((g) => g.status === "ok").length;
  const restRemaining = rest.length - restConfigured;
  const configured = summary.groups.filter(
    (g) => g.tier === "feature" && g.status === "ok",
  ).length;
  const total = summary.groups.filter((g) => g.tier === "feature").length;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {/*
        min-w-0 / w-full / overflow-hidden all the way down so the dialog width
        wins. Otherwise a grid-based DialogContent sizes to the longest description
        and the list spills past the panel on older dialog primitives.
      */}
      <DialogContent className="w-[calc(100vw-2rem)] max-w-lg overflow-hidden sm:max-w-lg">
        <DialogHeader className="min-w-0">
          <DialogTitle>Your setup at a glance</DialogTitle>
          <DialogDescription>
            {summary.requiredComplete
              ? `Core setup is complete. ${configured} of ${total} integrations are configured — each one you add unlocks a feature.`
              : "Some required keys are still missing, so parts of the app can't run yet. Guided setup walks you through each one."}
          </DialogDescription>
        </DialogHeader>

        <ul className="max-h-[55vh] w-full min-w-0 divide-y overflow-y-auto overflow-x-hidden rounded-xl border">
          {headline.map((g) => (
            <li
              key={g.title}
              className="flex w-full min-w-0 items-center gap-3 px-3 py-2.5"
            >
              <StatusIcon status={g.status} />
              <div className="min-w-0 flex-1 overflow-hidden">
                <p className="truncate text-sm font-medium">
                  {shortLabel(g.title)}
                </p>
                {g.status !== "ok" && g.off && (
                  <p
                    className="truncate text-xs text-muted-foreground"
                    title={`Off: ${g.off}`}
                  >
                    Off: {g.off}
                  </p>
                )}
              </div>
              <span
                className={cn(
                  "shrink-0 whitespace-nowrap text-xs",
                  g.status === "ok"
                    ? "text-emerald-600 dark:text-emerald-400"
                    : g.status === "error"
                      ? "text-rose-600 dark:text-rose-400"
                      : "text-muted-foreground",
                )}
              >
                {statusWord(g.status)}
              </span>
            </li>
          ))}
        </ul>
        {rest.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Plus {restConfigured} more configured and {restRemaining} more
            available — see them all in Guided setup.
          </p>
        )}

        <DialogFooter className="w-full min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <label className="flex min-w-0 cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <Checkbox
              checked={dontShowAgain}
              onCheckedChange={(v) => setDontShowAgain(!!v)}
              aria-label="Don't show this again"
            />
            Don&apos;t show this again
          </label>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              render={<Link href="/agency/get-started" />}
              onClick={() => handleOpenChange(false)}
            >
              Get started
            </Button>
            <Button
              size="sm"
              render={<Link href="/agency/setup" />}
              onClick={() => handleOpenChange(false)}
            >
              <KeyRound className="mr-1 h-3.5 w-3.5" />
              Open Guided setup
              <ArrowRight className="ml-1 h-3 w-3" />
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
