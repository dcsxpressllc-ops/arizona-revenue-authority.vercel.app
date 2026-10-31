"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  collection,
  doc,
  onSnapshot,
  query,
} from "firebase/firestore";
import { ArrowLeft, Loader2, Mail, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { useSubAccount } from "@/context/sub-account-context";
import { getFirebaseDb } from "@/lib/firebase/client";
import { formatContactDate, formatRelativeTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { PipelineStage } from "@/types/deals";
import { usePipelineStages } from "@/hooks/use-pipeline-stages";
import type {
  BroadcastAudienceFilter,
  BroadcastDoc,
  BroadcastSendDoc,
} from "@/types";

// Broadcast detail: totals and engagement, then per-recipient status, live
// via onSnapshot as the QStash fan-out drains and delivery events arrive.
export default function BroadcastDetailPage() {
  const params = useParams<{ broadcastId: string }>();
  const id = params.broadcastId;
  const router = useRouter();
  const { subAccountId, subAccount, saPath } = useSubAccount();
  const stages = usePipelineStages();
  const [broadcast, setBroadcast] = useState<BroadcastDoc | null>(null);
  const [sends, setSends] = useState<BroadcastSendDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [resendOpen, setResendOpen] = useState(false);
  const [resending, setResending] = useState(false);

  useEffect(() => {
    if (!id) return;
    const unsubBroadcast = onSnapshot(
      doc(getFirebaseDb(), "broadcasts", id),
      (snap) => {
        setBroadcast(snap.exists() ? (snap.data() as BroadcastDoc) : null);
        setLoading(false);
      },
      () => setLoading(false),
    );
    const unsubSends = onSnapshot(
      query(collection(getFirebaseDb(), "broadcasts", id, "sends")),
      (snap) => {
        const list = snap.docs.map((d) => d.data() as BroadcastSendDoc);
        list.sort((a, b) => {
          // Failed first (what the operator needs to see), then queued, sent, skipped.
          const order: Record<BroadcastSendDoc["status"], number> = {
            failed: 0,
            queued: 1,
            sent: 2,
            skipped: 3,
          };
          const o = order[a.status] - order[b.status];
          if (o !== 0) return o;
          return a.toName.localeCompare(b.toName);
        });
        setSends(list);
      },
    );
    return () => {
      unsubBroadcast();
      unsubSends();
    };
  }, [id]);

  // Same rule as the server's unopened audience, so the dialog count matches.
  const unopenedCount = useMemo(
    () =>
      sends.filter(
        (s) =>
          s.status === "sent" &&
          !s.openedAt &&
          !s.clickedAt &&
          !s.bouncedAt &&
          !s.complainedAt,
      ).length,
    [sends],
  );

  // The switch only exists for a verified dedicated domain; shared-domain
  // workspaces have tracking set in the provider dashboard, so no hint.
  const hasOwnDomain = subAccount?.resendConfig?.status === "verified";
  const trackingOn = subAccount?.resendConfig?.trackingEnabled === true;

  async function handleResend() {
    if (!broadcast) return;
    setResending(true);
    try {
      const res = await fetch("/api/broadcasts/email/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subAccountId,
          templateId: broadcast.templateId,
          audienceFilter: { kind: "broadcast_unopened", broadcastId: id },
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        broadcastId?: string;
        error?: string;
      };
      if (!res.ok || !data.broadcastId) {
        throw new Error(data.error ?? "Failed to start the re-send.");
      }
      toast.success("Re-send queued.");
      setResendOpen(false);
      router.push(saPath(`/broadcasts/${data.broadcastId}`));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to re-send.");
    } finally {
      setResending(false);
    }
  }

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-3">
        <div className="h-6 w-40 animate-pulse rounded bg-muted/40" />
        <div className="h-24 animate-pulse rounded-xl border bg-muted/30" />
        <div className="h-64 animate-pulse rounded-xl border bg-muted/30" />
      </div>
    );
  }
  if (!broadcast) {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-4">
        <Link
          href={saPath("/broadcasts")}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3 w-3" />
          Back to broadcasts
        </Link>
        <div className="rounded-2xl border border-dashed bg-card/50 p-10 text-center">
          <h3 className="text-base font-semibold">Broadcast not found</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            It may have been deleted, or you don&apos;t have access.
          </p>
        </div>
      </div>
    );
  }

  const t = broadcast.totals;
  const delivered = t.delivered ?? 0;
  const opened = t.opened ?? 0;
  const clicked = t.clicked ?? 0;
  const bounced = t.bounced ?? 0;
  const complained = t.complained ?? 0;
  const rate = (n: number) =>
    delivered > 0 ? `${Math.round((n / delivered) * 100)}%` : "—";
  const progress =
    t.audienceSize > 0
      ? Math.round(((t.sent + t.skipped + t.failed) / t.audienceSize) * 100)
      : 0;
  const canResend = broadcast.status === "completed" && unopenedCount > 0;

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <div>
        <Link
          href={saPath("/broadcasts")}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3 w-3" />
          Back to broadcasts
        </Link>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
              <span className="flex h-7 w-7 items-center justify-center rounded-md bg-blue-500/10 text-blue-600 dark:text-blue-400">
                <Mail className="h-4 w-4" />
              </span>
              {broadcast.templateName}
            </h1>
            {broadcast.subjectPreview && (
              <p className="mt-1 text-sm text-muted-foreground">
                {broadcast.subjectPreview}
              </p>
            )}
            <p className="mt-1 text-xs text-muted-foreground">
              {audienceLabel(broadcast.audienceFilter, stages)} · sent{" "}
              {formatRelativeTime(broadcast.createdAt)} by{" "}
              {broadcast.createdBy?.displayName ||
                broadcast.createdBy?.email ||
                "—"}
              {broadcast.resendOfBroadcastId && (
                <>
                  {" "}
                  ·{" "}
                  <Link
                    href={saPath(`/broadcasts/${broadcast.resendOfBroadcastId}`)}
                    className="underline-offset-2 hover:underline"
                  >
                    re-send of an earlier broadcast
                  </Link>
                </>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {canResend && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setResendOpen(true)}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Resend to unopened ({unopenedCount})
              </Button>
            )}
            <StatusBadge status={broadcast.status} />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SummaryCard label="Delivered" value={delivered} tone="emerald" />
        <SummaryCard
          label="Opened"
          value={opened}
          sub={rate(opened)}
          tone={opened > 0 ? "emerald" : "muted"}
        />
        <SummaryCard
          label="Clicked"
          value={clicked}
          sub={rate(clicked)}
          tone={clicked > 0 ? "emerald" : "muted"}
        />
        <SummaryCard
          label="Bounced"
          value={bounced}
          sub={complained > 0 ? `${complained} spam` : undefined}
          tone={bounced > 0 || complained > 0 ? "rose" : "muted"}
        />
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
        <span>
          Sent <strong className="text-foreground">{t.sent}</strong>
        </span>
        <span>
          Skipped <strong className="text-foreground">{t.skipped}</strong>
        </span>
        <span>
          Failed <strong className="text-foreground">{t.failed}</strong>
        </span>
        <span>
          Audience <strong className="text-foreground">{t.audienceSize}</strong>
        </span>
      </div>

      {hasOwnDomain && !trackingOn && delivered > 0 && opened === 0 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-800 dark:text-amber-400">
          Opens and clicks aren&apos;t being tracked for this workspace&apos;s
          sending domain. Turn on{" "}
          <Link
            href={saPath("/dashboard/settings")}
            className="underline-offset-2 hover:underline"
          >
            Open &amp; click tracking
          </Link>{" "}
          under Email sending domain to report them on future broadcasts.
        </div>
      )}

      {broadcast.status !== "completed" && broadcast.status !== "failed" && (
        <div className="rounded-xl border bg-card p-4">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Progress</span>
            <span className="font-mono">{progress}%</span>
          </div>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-blue-500 transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
          {t.queued > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              {t.queued} still queued — sending at ~5/sec via QStash.
            </p>
          )}
        </div>
      )}

      {broadcast.errorMessage && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {broadcast.errorMessage}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border bg-card">
        <div className="border-b bg-muted/40 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Recipients ({sends.length})
        </div>
        {sends.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            No recipients yet.
          </div>
        ) : (
          <ul className="divide-y">
            {sends.map((s) => (
              <li
                key={s.id}
                className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{s.toName || s.toEmail}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {s.toEmail}
                  </p>
                </div>
                <EngagementChips send={s} />
                <SendStatus send={s} />
                <span className="text-xs text-muted-foreground">
                  {formatContactDate(s.sentAt) === "—"
                    ? "—"
                    : formatRelativeTime(s.sentAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Dialog open={resendOpen} onOpenChange={setResendOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Resend to unopened</DialogTitle>
            <DialogDescription>
              Sends <strong>{broadcast.templateName}</strong> again, unchanged,
              to the {unopenedCount} recipient{unopenedCount === 1 ? "" : "s"}{" "}
              who received it but never opened it. Anyone who bounced, marked
              it as spam or has since opted out is left out.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col-reverse items-stretch gap-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setResendOpen(false)}
              disabled={resending}
            >
              Cancel
            </Button>
            <Button type="button" onClick={handleResend} disabled={resending}>
              {resending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Queuing…
                </>
              ) : (
                `Resend to ${unopenedCount}`
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function audienceLabel(
  filter: BroadcastAudienceFilter,
  stages: PipelineStage[],
): string {
  if (filter.kind === "all") return "All contacts";
  if (filter.kind === "tag") return `Tag: ${filter.tag}`;
  if (filter.kind === "broadcast_unopened") return "Re-send to unopened";
  const stage = stages.find((s) => s.id === filter.stage);
  return `Stage: ${stage?.label ?? filter.stage}`;
}

function EngagementChips({ send }: { send: BroadcastSendDoc }) {
  if (send.status !== "sent") return null;
  const chips: { label: string; className: string; title?: string }[] = [];
  if (send.complainedAt) {
    chips.push({
      label: "Spam",
      className: "bg-rose-500/15 text-rose-700 ring-rose-500/30 dark:text-rose-300",
    });
  }
  if (send.bouncedAt) {
    chips.push({
      label: "Bounced",
      className: "bg-rose-500/15 text-rose-700 ring-rose-500/30 dark:text-rose-300",
      title: send.bounceReason ?? undefined,
    });
  } else {
    if (send.clickedAt) {
      chips.push({
        label: (send.clicks ?? 1) > 1 ? `Clicked ×${send.clicks}` : "Clicked",
        className:
          "bg-emerald-500/15 text-emerald-700 ring-emerald-500/30 dark:text-emerald-300",
        title: formatContactDate(send.clickedAt),
      });
    }
    if (send.openedAt) {
      chips.push({
        label: (send.opens ?? 1) > 1 ? `Opened ×${send.opens}` : "Opened",
        className:
          "bg-emerald-500/10 text-emerald-700 ring-emerald-500/20 dark:text-emerald-300",
        title: formatContactDate(send.openedAt),
      });
    } else if (send.deliveredAt) {
      chips.push({
        label: "Delivered",
        className:
          "bg-sky-500/10 text-sky-700 ring-sky-500/20 dark:text-sky-300",
        title: formatContactDate(send.deliveredAt),
      });
    }
  }
  if (chips.length === 0) return null;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {chips.map((c) => (
        <span
          key={c.label}
          title={c.title}
          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ${c.className}`}
        >
          {c.label}
        </span>
      ))}
    </span>
  );
}

function SendStatus({ send }: { send: BroadcastSendDoc }) {
  if (send.status === "sent") {
    return (
      <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 ring-1 ring-emerald-500/30 dark:text-emerald-300">
        Sent
      </span>
    );
  }
  if (send.status === "queued") {
    return (
      <span className="rounded-full bg-slate-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-700 ring-1 ring-slate-500/30 dark:text-slate-300">
        Queued
      </span>
    );
  }
  if (send.status === "skipped") {
    const reason =
      send.skippedReason === "opt_out"
        ? "Opted out"
        : send.skippedReason === "no_email"
          ? "No email"
          : send.skippedReason === "bounced"
            ? "Bounced before"
            : send.skippedReason === "contact_missing"
              ? "Contact deleted"
              : "Skipped";
    return (
      <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 ring-1 ring-amber-500/30 dark:text-amber-300">
        {reason}
      </span>
    );
  }
  return (
    <span
      title={send.error ?? undefined}
      className="rounded-full bg-rose-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-rose-700 ring-1 ring-rose-500/30 dark:text-rose-300"
    >
      Failed
    </span>
  );
}

function StatusBadge({ status }: { status: BroadcastDoc["status"] }) {
  const map: Record<BroadcastDoc["status"], string> = {
    queued:
      "bg-slate-500/15 text-slate-700 ring-1 ring-slate-500/30 dark:text-slate-300",
    sending:
      "bg-blue-500/15 text-blue-700 ring-1 ring-blue-500/30 dark:text-blue-300",
    completed:
      "bg-emerald-500/15 text-emerald-700 ring-1 ring-emerald-500/30 dark:text-emerald-300",
    failed:
      "bg-rose-500/15 text-rose-700 ring-1 ring-rose-500/30 dark:text-rose-300",
  };
  return (
    <span
      className={`rounded-full px-2.5 py-1 text-xs font-semibold uppercase tracking-wide ${map[status]}`}
    >
      {status}
    </span>
  );
}

function SummaryCard({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: number;
  /** e.g. the rate; shown after the number. */
  sub?: string;
  tone: "emerald" | "rose" | "muted";
}) {
  const valueClass =
    tone === "emerald"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "rose"
        ? "text-rose-600 dark:text-rose-400"
        : "text-foreground";
  return (
    <div className="rounded-xl border bg-card p-4">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className={`mt-1 font-mono text-2xl font-semibold ${valueClass}`}>
        {value}
        {sub && (
          <span className="ml-1.5 text-sm font-medium text-muted-foreground">
            {sub}
          </span>
        )}
      </p>
    </div>
  );
}
