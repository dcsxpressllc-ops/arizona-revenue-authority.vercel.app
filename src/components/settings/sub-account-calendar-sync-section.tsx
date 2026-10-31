"use client";

import { useEffect, useState } from "react";
import { collection, onSnapshot } from "firebase/firestore";
import { toast } from "sonner";
import {
  AlertTriangle,
  CalendarCheck,
  CheckCircle2,
  Copy,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useSubAccount } from "@/context/sub-account-context";
import { getFirebaseDb } from "@/lib/firebase/client";
import { toDate, formatRelativeTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import type {
  CalendarConnectionDoc,
  CalendarImportMode,
} from "@/types/calendar-sync";

/**
 * Calendar sync panel, two layers:
 * 1. Google Calendar (two-way, beta): each member connects their own account.
 *    Their busy times block booking slots, and bookings assigned to them land
 *    in Google within seconds (moved on reschedule, removed on cancel). Status
 *    reads live from the member-readable calendarConnections subcollection.
 * 2. .ics feed (one-way): subscription URL fallback for unconnected or
 *    non-Google calendars. Clients poll on their own cadence (Google: 8-24h).
 * Visible to every active member. "Just my bookings" is server-scoped to the
 * caller's uid (see the calendar-feed-url route).
 */
export function SubAccountCalendarSyncSection() {
  const { subAccountId } = useSubAccount();
  const [url, setUrl] = useState<string | null>(null);
  const [hostUrl, setHostUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/sub-accounts/${subAccountId}/calendar-feed-url`)
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as {
          url?: string;
          hostUrl?: string;
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok || !data.url) {
          setError(data.error ?? "Couldn't load the calendar feed URL.");
        } else {
          setUrl(data.url);
          setHostUrl(data.hostUrl ?? null);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Network error.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [subAccountId]);

  async function copyText(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success("Calendar URL copied.");
    } catch {
      toast.error("Clipboard blocked — select the URL and copy manually.");
    }
  }

  return (
    <section className="rounded-2xl border bg-card p-6">
      <header className="mb-4 flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-teal-500/10 text-teal-600 dark:text-teal-400">
          <CalendarCheck className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">Calendar sync</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Connect Google Calendar for true two-way sync, or subscribe to
            the read-only feed from any calendar app.
          </p>
        </div>
      </header>

      <GoogleCalendarSyncBlock />

      <div className="mb-3 mt-6 flex items-center gap-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Calendar feed (read-only fallback)
        </p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center rounded-lg border bg-background p-6 text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          Generating your calendar URL…
        </div>
      ) : error ? (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-4 text-sm text-rose-700 dark:text-rose-400">
          {error}
        </div>
      ) : url ? (
        <>
          <div className="space-y-3">
            <FeedUrlRow
              label="All bookings"
              hint="Everyone's bookings in this sub-account — the shared team calendar."
              url={url}
              onCopy={() => copyText(url)}
            />
            {hostUrl && (
              <FeedUrlRow
                label="Just my bookings"
                hint="Only bookings assigned to you — useful when a page runs as a team (round-robin)."
                url={hostUrl}
                onCopy={() => copyText(hostUrl)}
              />
            )}
          </div>

          <div className="mt-5 space-y-4">
            <Steps
              title="Google Calendar"
              steps={[
                <>
                  Open{" "}
                  <a
                    href="https://calendar.google.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary underline-offset-2 hover:underline"
                  >
                    calendar.google.com
                  </a>
                  .
                </>,
                <>
                  In the left sidebar, click <strong>+</strong> next to{" "}
                  <strong>Other calendars</strong> → <strong>From URL</strong>.
                </>,
                <>
                  Paste the URL above into the field, then click{" "}
                  <strong>Add calendar</strong>.
                </>,
                <>
                  Your LeadStack bookings appear within a few hours. Google
                  polls subscribed calendars on its own schedule (typically
                  8&ndash;24 hours).
                </>,
              ]}
            />
            <Steps
              title="Apple Calendar"
              steps={[
                <>
                  Open <strong>Calendar</strong> on Mac.
                </>,
                <>
                  Menu: <strong>File</strong> →{" "}
                  <strong>New Calendar Subscription…</strong>
                </>,
                <>Paste the URL → set Auto-refresh to Every hour.</>,
              ]}
            />
            <Steps
              title="Outlook on the web"
              steps={[
                <>
                  Open <strong>Outlook Calendar</strong> →{" "}
                  <strong>Add calendar</strong> →{" "}
                  <strong>Subscribe from web</strong>.
                </>,
                <>
                  Paste the URL → give it a name → click{" "}
                  <strong>Import</strong>.
                </>,
              ]}
            />
          </div>

          <p className="mt-5 text-[11px] leading-relaxed text-muted-foreground">
            The feed is read-only — your external calendar receives our
            bookings but can&apos;t edit them. To keep events private, treat
            this URL like a password. If it leaks, rotate{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-[10px]">
              AUTOMATIONS_TOKEN_SECRET
            </code>{" "}
            on the deployment (invalidates every feed URL across the
            agency).
          </p>
        </>
      ) : null}
    </section>
  );
}

/** Two-way Google sync. Admins also see, and can disconnect, every member's connection. */
function GoogleCalendarSyncBlock() {
  const { user } = useAuth();
  const { subAccountId, isAdmin, subAccount } = useSubAccount();
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [connections, setConnections] = useState<CalendarConnectionDoc[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [busy, setBusy] = useState(false);

  // Deployment-level env check (drives the not-configured state).
  useEffect(() => {
    let cancelled = false;
    fetch("/api/agency/deployment-config")
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as {
          googleCalendarConfigured?: boolean;
        };
        if (!cancelled) setConfigured(data.googleCalendarConfigured === true);
      })
      .catch(() => {
        if (!cancelled) setConfigured(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Live connection roster.
  useEffect(() => {
    const db = getFirebaseDb();
    const unsub = onSnapshot(
      collection(db, `subAccounts/${subAccountId}/calendarConnections`),
      (snap) => {
        setConnections(
          snap.docs.map((d) => d.data() as CalendarConnectionDoc),
        );
        setHydrated(true);
      },
      () => setHydrated(true),
    );
    return unsub;
  }, [subAccountId]);

  // Toast the OAuth callback's ?gcal=... status once, then strip the param.
  useEffect(() => {
    const url = new URL(window.location.href);
    const status = url.searchParams.get("gcal");
    if (!status) return;
    url.searchParams.delete("gcal");
    window.history.replaceState({}, "", url.toString());
    switch (status) {
      case "connected":
        toast.success("Google Calendar connected.");
        break;
      case "cancelled":
        toast.info("Google Calendar connection cancelled.");
        break;
      case "not_configured":
        toast.error("Google Calendar sync isn't configured on this deployment.");
        break;
      case "bad_state":
        toast.error("Connection link expired — try Connect again.");
        break;
      default:
        toast.error("Couldn't connect Google Calendar. Try again.");
    }
  }, []);

  const mine = connections.find((c) => c.uid === user?.uid) ?? null;
  const others = connections.filter((c) => c.uid !== user?.uid);

  function connect() {
    window.location.href = `/api/sub-accounts/${subAccountId}/calendar-sync/connect`;
  }

  async function disconnect(uid?: string) {
    setBusy(true);
    try {
      const qs = uid ? `?uid=${encodeURIComponent(uid)}` : "";
      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/calendar-sync${qs}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "Disconnect failed.");
      }
      toast.success("Google Calendar disconnected.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Disconnect failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border bg-background p-4">
      <div className="mb-2 flex items-center gap-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Google Calendar (two-way)
        </p>
        <span className="rounded-full bg-fuchsia-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-fuchsia-600 dark:text-fuchsia-400">
          Beta
        </span>
      </div>
      <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
        Connect your Google account and two things happen: your Google busy
        times <strong>block booking-page slots</strong> (no more
        double-booking), and bookings assigned to you{" "}
        <strong>appear in Google instantly</strong> — moved on reschedule,
        removed on cancel. For booking pages only opaque busy blocks are
        read. Your Google events only appear on the CRM calendar if you turn
        that on below.
      </p>

      {configured === false ? (
        <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
          Not configured on this deployment. Ask your developer to set{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-[10px]">
            GOOGLE_OAUTH_CLIENT_ID
          </code>{" "}
          and{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-[10px]">
            GOOGLE_OAUTH_CLIENT_SECRET
          </code>{" "}
          (see the setup guide).
        </div>
      ) : configured === null || !hydrated ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Checking connection…
        </div>
      ) : (
        <>
          {mine ? (
            <div className="flex flex-wrap items-center gap-2 rounded-md border p-3">
              <ConnectionStatusChip status={mine.status} />
              <span className="min-w-0 flex-1 truncate text-xs">
                {mine.googleEmail ?? "Google account"}
                {mine.status === "connected" && mine.lastSyncAt && (
                  <span className="ml-2 text-muted-foreground">
                    Last checked{" "}
                    {formatRelativeTime(toDate(mine.lastSyncAt) ?? new Date())}
                  </span>
                )}
              </span>
              {mine.status === "error" && (
                <Button type="button" size="sm" onClick={connect} disabled={busy}>
                  <RefreshCw className="mr-1 h-3.5 w-3.5" />
                  Reconnect
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => disconnect()}
                disabled={busy}
              >
                Disconnect
              </Button>
            </div>
          ) : (
            <Button type="button" size="sm" onClick={connect}>
              Connect Google Calendar
            </Button>
          )}
          {mine?.status === "error" && (
            <p className="mt-2 text-[11px] leading-relaxed text-rose-600 dark:text-rose-400">
              Google revoked or expired this connection. Until you reconnect,
              booking pages can&apos;t see your Google busy times (your
              internal bookings still block as usual).
            </p>
          )}

          <GoogleImportControls
            subAccountId={subAccountId}
            allowed={subAccount?.calendarImportAllowed === true}
            isAdmin={isAdmin}
            mine={mine}
          />

          {isAdmin && others.length > 0 && (
            <div className="mt-4">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Team connections
              </p>
              <div className="space-y-2">
                {others.map((c) => (
                  <div
                    key={c.uid}
                    className="flex flex-wrap items-center gap-2 rounded-md border p-2"
                  >
                    <ConnectionStatusChip status={c.status} />
                    <span className="min-w-0 flex-1 truncate text-xs">
                      {c.googleEmail ?? c.uid}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => disconnect(c.uid)}
                      disabled={busy}
                      className="h-7 text-xs text-muted-foreground"
                    >
                      Disconnect
                    </Button>
                  </div>
                ))}
              </div>
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                An errored connection needs that member to reconnect
                themselves — only they can approve Google&apos;s consent
                screen.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const IMPORT_OPTIONS: {
  value: CalendarImportMode;
  label: string;
  hint: string;
}[] = [
  {
    value: "off",
    label: "Off",
    hint: "Nothing from your Google Calendar appears in the CRM.",
  },
  {
    value: "busy",
    label: "Busy only",
    hint: "Your team sees when you're busy, with no titles or places.",
  },
  {
    value: "details",
    label: "Full details",
    hint: "Your team sees titles and places. Events you marked private in Google stay Busy.",
  },
];

/**
 * Showing Google events on the CRM calendar needs two keys: an admin allows it
 * for the workspace, then each person chooses for their OWN calendar.
 */
function GoogleImportControls({
  subAccountId,
  allowed,
  isAdmin,
  mine,
}: {
  subAccountId: string;
  allowed: boolean;
  isAdmin: boolean;
  mine: CalendarConnectionDoc | null;
}) {
  const [saving, setSaving] = useState(false);
  const mode: CalendarImportMode = mine?.importMode ?? "off";

  async function patch(body: Record<string, unknown>, success: string) {
    setSaving(true);
    try {
      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/calendar-sync/import`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Couldn't save.");
      toast.success(success);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save.");
    } finally {
      setSaving(false);
    }
  }

  function chooseMode(next: CalendarImportMode) {
    if (next === mode) return;
    if (
      next === "details" &&
      !confirm(
        "Everyone in this workspace will see the titles, times and places of your Google Calendar events. Events you marked private in Google stay as Busy. Continue?",
      )
    ) {
      return;
    }
    void patch(
      { mode: next },
      next === "off"
        ? "Your Google events were removed from the CRM calendar."
        : "Saved. Your Google events will appear on the CRM calendar shortly.",
    );
  }

  function toggleWorkspace(next: boolean) {
    if (
      !next &&
      !confirm(
        "Turn this off for everyone? Every imported Google event is removed from the CRM calendar now.",
      )
    ) {
      return;
    }
    void patch(
      { allowWorkspace: next },
      next
        ? "Team members can now choose to show their Google events."
        : "Turned off and imported events removed.",
    );
  }

  const lastSync = mine?.importLastSyncAt ? toDate(mine.importLastSyncAt) : null;

  return (
    <div className="mt-4 space-y-3 border-t pt-4">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Show Google events on the CRM calendar
      </p>
      {isAdmin && (
        <label className="flex cursor-pointer items-start gap-3 rounded-md border p-3">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 cursor-pointer"
            checked={allowed}
            disabled={saving}
            onChange={(e) => toggleWorkspace(e.target.checked)}
          />
          <span className="text-xs leading-relaxed">
            <span className="block font-medium">
              Allow team members to show their Google events
            </span>
            <span className="text-muted-foreground">
              Off by default. Each person still chooses for their own calendar;
              admins can&apos;t turn it on for someone else.
            </span>
          </span>
        </label>
      )}
      {!allowed ? (
        <p className="text-xs text-muted-foreground">
          {isAdmin
            ? "While this is off, nobody's Google events appear in the CRM."
            : "Not enabled in this workspace. Ask an admin if you'd like to show your Google events on the CRM calendar."}
        </p>
      ) : !mine || (mine.status !== "connected" && mode === "off") ? (
        <p className="text-xs text-muted-foreground">
          Connect your Google Calendar above to choose what to show.
        </p>
      ) : (
        <div className="space-y-2">
          <p className="text-xs font-medium">
            Your Google Calendar on the CRM calendar
          </p>
          <div className="grid gap-2 sm:grid-cols-3">
            {IMPORT_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                // Off always works; showing more needs a working connection.
                disabled={
                  saving || (o.value !== "off" && mine.status !== "connected")
                }
                onClick={() => chooseMode(o.value)}
                aria-pressed={mode === o.value}
                className={
                  mode === o.value
                    ? "rounded-md border border-primary bg-primary/5 p-2 text-left"
                    : "rounded-md border p-2 text-left hover:bg-muted/40"
                }
              >
                <span className="block text-xs font-medium">{o.label}</span>
                <span className="block text-[11px] leading-snug text-muted-foreground">
                  {o.hint}
                </span>
              </button>
            ))}
          </div>
          {mode !== "off" && (
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <span>
                {mine.importStatus === "error"
                  ? `Last sync failed: ${mine.importError ?? "unknown error"}`
                  : lastSync
                    ? `${mine.importedCount ?? 0} events, synced ${formatRelativeTime(lastSync)}. Refreshes about every 15 minutes.`
                    : "First sync in progress…"}
                {mine.importError === "too_many_events" &&
                  " Only the next 2,000 events are shown."}
              </span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 text-xs"
                disabled={saving}
                onClick={() =>
                  void patch({ syncNow: true }, "Synced with Google Calendar.")
                }
              >
                <RefreshCw className="mr-1 h-3 w-3" />
                Sync now
              </Button>
            </div>
          )}
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Imported events are read-only in the CRM and never shared through
            the API, the assistant, search or booking pages. Events marked
            Free, invites you declined and your own CRM bookings are skipped.
          </p>
        </div>
      )}
    </div>
  );
}

function ConnectionStatusChip({
  status,
}: {
  status: CalendarConnectionDoc["status"];
}) {
  if (status === "connected") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
        <CheckCircle2 className="h-3 w-3" />
        Connected
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-rose-600 dark:text-rose-400">
      <AlertTriangle className="h-3 w-3" />
      Reconnect needed
    </span>
  );
}

function FeedUrlRow({
  label,
  hint,
  url,
  onCopy,
}: {
  label: string;
  hint: string;
  url: string;
  onCopy: () => void;
}) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-semibold">{label}</p>
      <div className="flex items-center gap-2 rounded-md border bg-background p-2 font-mono text-xs">
        <code className="min-w-0 flex-1 truncate">{url}</code>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onCopy}
          className="shrink-0"
        >
          <Copy className="mr-1 h-3.5 w-3.5" />
          Copy
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">{hint}</p>
    </div>
  );
}

function Steps({
  title,
  steps,
}: {
  title: string;
  steps: React.ReactNode[];
}) {
  return (
    <div>
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </p>
      <ol className="ml-4 list-decimal space-y-1 text-xs leading-relaxed">
        {steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
    </div>
  );
}
