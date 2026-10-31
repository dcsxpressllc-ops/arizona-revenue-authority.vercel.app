"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  Check,
  Copy,
  Loader2,
  Lock,
  Mail,
  Pencil,
  Trash2,
} from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * Sub-account sending-domain setup (platform-managed), shown as a five-step stepper:
 * Reply-To, register subdomain, DNS + verify, verified, optional two-way inbox (MX).
 * DNS records are never persisted, they're re-fetched on demand. Everything else
 * derives from the live sub-account doc.
 */

interface DnsRecord {
  record: string;
  name: string;
  type: string;
  value: string;
  ttl?: string;
  priority?: number;
  status?: string;
}

/**
 * Per-provider DNS guidance (steps 3 + 5). Records are identical everywhere; only
 * where to paste them and the quirks differ. Remembered per browser.
 */
interface DnsProvider {
  id: string;
  label: string;
  where: string;
  /** Host/Name field convention + TTL note. */
  hostTip: string;
  /** Quirk for adding MX records. */
  mxTip: string;
}

const DNS_PROVIDERS: DnsProvider[] = [
  {
    id: "cloudflare",
    label: "Cloudflare",
    where: "Log in → pick your domain → DNS → Records → Add record.",
    hostTip:
      "Paste the Name exactly as shown — Cloudflare appends your domain automatically. TTL 'Auto' is fine.",
    mxTip:
      "Choose type MX and put the priority number in the Priority field. TXT/MX rows have no orange proxy cloud — nothing to toggle.",
  },
  {
    id: "namecheap",
    label: "Namecheap",
    where: "Domain List → Manage (next to your domain) → Advanced DNS.",
    hostTip:
      "Paste the Name into the Host field exactly as shown (it's relative to your root domain). TTL 'Automatic' is fine.",
    mxTip:
      "MX records are NOT in the normal add-record list — scroll to the 'Mail Settings' section, switch it to 'Custom MX', and add the record there with the priority shown.",
  },
  {
    id: "godaddy",
    label: "GoDaddy",
    where: "My Products → your domain → DNS → Manage DNS.",
    hostTip:
      "Paste the Name into the Host/Name field as shown. The default TTL is fine.",
    mxTip:
      "Add a record of type MX; the priority number goes in its own Priority field.",
  },
  {
    id: "crazydomains",
    label: "Crazy Domains",
    where: "Account → Domains → your domain → DNS Settings.",
    hostTip:
      "Paste the Name into the Hostname field as shown. Leave TTL at the default.",
    mxTip: "Add an MX record and set its priority to the value shown.",
  },
  {
    id: "ventraip",
    label: "VentraIP",
    where: "VIPControl → My Services → Domains → your domain → DNS & Zone editor.",
    hostTip:
      "Paste the Name into the Hostname field as shown. The default TTL is fine.",
    mxTip: "Add an MX record and enter the priority value shown.",
  },
  {
    id: "squarespace",
    label: "Squarespace Domains",
    where: "Settings → Domains → your domain → DNS settings → Add record.",
    hostTip:
      "Paste the Name into the Host field as shown. The default TTL is fine.",
    mxTip: "Add a record of type MX; the priority goes in the Priority field.",
  },
  {
    id: "other",
    label: "Other / not sure",
    where: "Open your DNS provider's record editor for your root domain.",
    hostTip:
      "The Name/Host is relative to your root domain — paste it as shown. The default TTL is fine.",
    mxTip:
      "Add an MX record; enter the priority number wherever your provider asks for it.",
  },
];

const DNS_PROVIDER_STORAGE_KEY = "ls-dns-provider";

/**
 * Per-record chip from Resend's record `status`, so a stuck verification points
 * at the exact record rather than a flat "not verified".
 */
function RecordStatusChip({ status }: { status?: string }) {
  if (!status) return null;
  const s = status.toLowerCase();
  const verified = s === "verified";
  const failed = s.includes("fail");
  return (
    <span
      className={cn(
        "ml-auto rounded-full px-2 py-0.5 text-[10px] font-medium",
        verified
          ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
          : failed
            ? "bg-rose-500/10 text-rose-700 dark:text-rose-400"
            : "bg-amber-500/10 text-amber-700 dark:text-amber-400",
      )}
    >
      {verified ? "✓ verified" : failed ? "✗ check failed" : "pending"}
    </span>
  );
}

/** One DNS record's fields, labeled like provider forms (Host, Value, Priority), each with a copy button. */
function DnsRecordFields({ record }: { record: DnsRecord }) {
  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <p className="text-[11px] text-muted-foreground">Host / Name</p>
        <CopyValue value={record.name} />
      </div>
      <div className="space-y-1">
        <p className="text-[11px] text-muted-foreground">Value</p>
        <CopyValue value={record.value} />
      </div>
      {typeof record.priority === "number" && (
        <div className="space-y-1">
          <p className="text-[11px] text-muted-foreground">Priority</p>
          <CopyValue value={String(record.priority)} />
        </div>
      )}
    </div>
  );
}

function ProviderGuidance({
  provider,
  showMxTip,
}: {
  provider: DnsProvider;
  showMxTip: boolean;
}) {
  return (
    <div className="rounded-lg border border-blue-500/25 bg-blue-500/5 p-3 text-xs text-muted-foreground">
      <p>
        <span className="font-medium text-foreground">
          In {provider.label}:
        </span>{" "}
        {provider.where} {provider.hostTip}
      </p>
      {showMxTip && <p className="mt-1.5">{provider.mxTip}</p>}
    </div>
  );
}

function CopyValue({ value }: { value: string }) {
  return (
    <div className="flex items-center gap-2">
      <code className="flex-1 break-all rounded bg-background px-2 py-1 text-[11px]">
        {value}
      </code>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="shrink-0"
        onClick={() => {
          void navigator.clipboard.writeText(value);
          toast.success("Copied");
        }}
      >
        <Copy className="h-3 w-3" />
      </Button>
    </div>
  );
}

type StepState = "done" | "current" | "upcoming";

/** One stepper row: indicator + title + summary/body. */
function Step({
  index,
  state,
  title,
  optional = false,
  summary,
  children,
}: {
  index: number;
  state: StepState;
  title: string;
  optional?: boolean;
  /** Shown when done (and kept when the body renders too). */
  summary?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className={cn("flex gap-3", state === "upcoming" && "opacity-50")}>
      <div className="flex flex-col items-center">
        <span
          className={cn(
            "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold",
            state === "done"
              ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
              : state === "current"
                ? "bg-primary/15 text-primary ring-1 ring-primary/40"
                : "bg-muted text-muted-foreground",
          )}
        >
          {state === "done" ? <Check className="h-3.5 w-3.5" /> : index}
        </span>
        <span className="mt-1 w-px flex-1 bg-border" aria-hidden />
      </div>
      <div className="min-w-0 flex-1 pb-5">
        <p
          className={cn(
            "text-sm font-medium",
            state === "current" && "text-foreground",
          )}
        >
          {title}
          {optional && (
            <span className="ml-2 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              optional
            </span>
          )}
        </p>
        {summary && (
          <p className="mt-0.5 text-xs text-muted-foreground">{summary}</p>
        )}
        {children && <div className="mt-3">{children}</div>}
      </div>
    </div>
  );
}

export function SubAccountEmailDomainSection() {
  const { subAccountId, subAccount, isAdmin } = useSubAccount();
  const cfg = subAccount?.resendConfig ?? null;
  const gateOpen = subAccount?.emailDomainEnabledByAgency === true;
  const replyToEmail = subAccount?.replyToEmail?.trim() ?? "";
  const verified = cfg?.status === "verified";
  const inboxOn = cfg?.inboxEnabled === true;
  const trackingOn = cfg?.trackingEnabled === true;

  const [domainName, setDomainName] = useState("");
  const [fromName, setFromName] = useState("");
  const [fromLocalPart, setFromLocalPart] = useState("");
  const [records, setRecords] = useState<DnsRecord[]>([]);
  const [adding, setAdding] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [inboxBusy, setInboxBusy] = useState(false);
  const [trackingBusy, setTrackingBusy] = useState(false);
  const [inboxRecords, setInboxRecords] = useState<DnsRecord[]>([]);
  const [replyToDraft, setReplyToDraft] = useState("");
  const [editingReplyTo, setEditingReplyTo] = useState(false);
  const [savingReplyTo, setSavingReplyTo] = useState(false);
  const [providerId, setProviderId] = useState("other");

  // DNS provider remembered per browser. Guarded: storage can throw in
  // private windows.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(DNS_PROVIDER_STORAGE_KEY);
      if (saved && DNS_PROVIDERS.some((p) => p.id === saved)) {
        setProviderId(saved);
      }
    } catch {
      /* default stands */
    }
  }, []);
  const provider =
    DNS_PROVIDERS.find((p) => p.id === providerId) ??
    DNS_PROVIDERS[DNS_PROVIDERS.length - 1];

  function pickProvider(id: string) {
    setProviderId(id);
    try {
      localStorage.setItem(DNS_PROVIDER_STORAGE_KEY, id);
    } catch {
      /* non-fatal */
    }
  }

  // Receiving MX rows (step 5), from the enable response or the last fetch.
  // Resend's sending setup also has an MX (return-path, feedback-smtp.<region>.amazonses.com);
  // that belongs to step 3 and is excluded here by value.
  const inboxMxRecords = (
    inboxRecords.length > 0 ? inboxRecords : records
  ).filter(
    (r) =>
      r.type.toUpperCase() === "MX" &&
      !r.value.toLowerCase().includes("feedback-smtp"),
  );

  const loadRecords = useCallback(async () => {
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/resend`);
      const data = (await res.json().catch(() => ({}))) as {
        records?: DnsRecord[];
      };
      if (Array.isArray(data.records)) setRecords(data.records);
    } catch {
      /* non-fatal: operator can still click Verify */
    }
  }, [subAccountId]);

  // Re-fetch records (they aren't stored) when a pending domain exists, and when
  // the inbox is on (the receiving MX row renders from live records).
  useEffect(() => {
    setRecords([]);
    if (cfg && (cfg.status !== "verified" || cfg.inboxEnabled === true)) {
      void loadRecords();
    }
  }, [cfg, loadRecords]);

  // Poll every 15s while pending. The GET syncs Resend's status onto the doc, so
  // the stepper advances on its own. Don't re-click Verify for this: it restarts
  // the whole check and resets record statuses to pending.
  const awaitingVerification = !!cfg && cfg.status !== "verified";
  useEffect(() => {
    if (!awaitingVerification) return;
    const timer = setInterval(() => void loadRecords(), 15_000);
    return () => clearInterval(timer);
  }, [awaitingVerification, loadRecords]);

  if (!isAdmin) return null;

  // Step states
  const s1: StepState = replyToEmail ? "done" : "current";
  const s2: StepState = cfg ? "done" : replyToEmail ? "current" : "upcoming";
  const s3: StepState = verified
    ? "done"
    : cfg
      ? "current"
      : "upcoming";
  const s4: StepState = verified ? "done" : "upcoming";
  const s5: StepState = inboxOn ? "done" : verified ? "current" : "upcoming";
  const s6: StepState = trackingOn ? "done" : verified ? "current" : "upcoming";

  async function handleSaveReplyTo(e: FormEvent) {
    e.preventDefault();
    const value = replyToDraft.trim();
    if (!value || !value.includes("@")) {
      toast.error("Enter a valid email address.");
      return;
    }
    setSavingReplyTo(true);
    try {
      const res = await fetch(`/api/agency/sub-accounts/${subAccountId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ replyToEmail: value }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to save.");
      setEditingReplyTo(false);
      toast.success("Reply-To saved.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setSavingReplyTo(false);
    }
  }

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    setAdding(true);
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/resend`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domainName: domainName.trim(),
          fromName: fromName.trim() || undefined,
          fromLocalPart: fromLocalPart.trim() || undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        records?: DnsRecord[];
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "Failed to add the domain.");
      }
      setRecords(data.records ?? []);
      toast.success("Domain registered. Add the DNS records, then verify.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add domain.");
    } finally {
      setAdding(false);
    }
  }

  async function handleVerify() {
    setVerifying(true);
    try {
      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/resend/verify`,
        { method: "POST" },
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        status?: string;
        records?: DnsRecord[];
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "Verification failed.");
      }
      if (Array.isArray(data.records)) setRecords(data.records);
      if (data.status === "verified") {
        toast.success("Domain verified. This sub-account now sends from it.");
      } else {
        toast.info(
          "Not verified yet — DNS can take a few minutes to propagate. Try again shortly.",
        );
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Verification failed.");
    } finally {
      setVerifying(false);
    }
  }

  async function handleRemove() {
    if (
      !confirm(
        "Remove this sending domain? Email for this sub-account reverts to the shared sender. The domain is deleted from Resend — re-adding it later requires verifying DNS again.",
      )
    ) {
      return;
    }
    setRemoving(true);
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/resend`, {
        method: "DELETE",
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "Failed to remove the domain.");
      }
      setRecords([]);
      setDomainName("");
      setFromName("");
      setFromLocalPart("");
      toast.success("Sending domain removed. Reverted to the shared sender.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove.");
    } finally {
      setRemoving(false);
    }
  }

  async function handleTrackingToggle(enable: boolean) {
    setTrackingBusy(true);
    try {
      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/resend/tracking`,
        { method: enable ? "POST" : "DELETE" },
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        throw new Error(
          data.error ?? `Failed to ${enable ? "enable" : "disable"} tracking.`,
        );
      }
      toast.success(
        enable
          ? "Open & click tracking enabled for broadcasts from this domain."
          : "Open & click tracking disabled.",
      );
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to update tracking.",
      );
    } finally {
      setTrackingBusy(false);
    }
  }

  async function handleInboxToggle(enable: boolean) {
    if (
      !enable &&
      !confirm(
        "Disable the email inbox? Replies go back to your Reply-To address and no longer appear in the unified inbox.",
      )
    ) {
      return;
    }
    setInboxBusy(true);
    try {
      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/resend/inbox`,
        { method: enable ? "POST" : "DELETE" },
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        records?: DnsRecord[];
      };
      if (!res.ok || !data.ok) {
        throw new Error(
          data.error ?? `Failed to ${enable ? "enable" : "disable"} the inbox.`,
        );
      }
      if (enable) {
        if (Array.isArray(data.records)) setInboxRecords(data.records);
        toast.success(
          "Email inbox enabled. Add the MX record below so replies can arrive.",
        );
      } else {
        toast.success("Email inbox disabled.");
      }
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to update the inbox.",
      );
    } finally {
      setInboxBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border bg-card p-6">
      <header className="mb-5 flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-600 dark:text-blue-400">
          <Mail className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold">Email sending domain</h2>
            <span className="rounded-full bg-fuchsia-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-fuchsia-600 dark:text-fuchsia-400">
              Beta
            </span>
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Send this sub-account&apos;s email from its own domain instead of
            the shared sender — and optionally receive replies into the
            Conversations inbox. Five steps, in order; your progress is saved
            as you go.
          </p>
        </div>
      </header>

      {!gateOpen ? (
        <div className="flex items-start gap-3 rounded-lg border border-dashed bg-muted/30 p-4 text-sm">
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="text-muted-foreground">
            <p className="font-medium text-foreground">
              Disabled by your agency
            </p>
            <p className="mt-1">
              Email for this sub-account is sending from the shared deployment
              address. Ask your agency owner to enable the dedicated sending
              domain feature from the agency sub-accounts page.
            </p>
          </div>
        </div>
      ) : (
        <div>
          {/* Step 1: Reply-To */}
          <Step
            index={1}
            state={s1}
            title="Reply-To address"
            summary={
              s1 === "done" && !editingReplyTo ? (
                <>
                  Replies route to{" "}
                  <span className="font-medium text-foreground">
                    {replyToEmail}
                  </span>{" "}
                  <button
                    type="button"
                    className="ml-1 inline-flex items-center gap-0.5 text-[11px] underline-offset-2 hover:underline"
                    onClick={() => {
                      setReplyToDraft(replyToEmail);
                      setEditingReplyTo(true);
                    }}
                  >
                    <Pencil className="h-3 w-3" /> Change
                  </button>
                </>
              ) : undefined
            }
          >
            {(s1 === "current" || editingReplyTo) && (
              <form
                onSubmit={handleSaveReplyTo}
                className="max-w-md space-y-2"
              >
                <p className="text-xs text-muted-foreground">
                  Your sending subdomain has no mailbox by default, so replies
                  need somewhere to go. This address catches them (until you
                  enable the two-way inbox in step 5). Also editable under
                  Sending preferences.
                </p>
                <div className="flex gap-2">
                  <Input
                    value={replyToDraft}
                    onChange={(e) => setReplyToDraft(e.target.value)}
                    placeholder="you@yourbusiness.com"
                    type="email"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <Button type="submit" size="sm" disabled={savingReplyTo}>
                    {savingReplyTo ? (
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    ) : null}
                    Save
                  </Button>
                  {editingReplyTo && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditingReplyTo(false)}
                    >
                      Cancel
                    </Button>
                  )}
                </div>
              </form>
            )}
          </Step>

          {/* Step 2: Register subdomain */}
          <Step
            index={2}
            state={s2}
            title="Register your subdomain"
            summary={
              cfg ? (
                <>
                  <span className="font-medium text-foreground">
                    {cfg.domainName}
                  </span>{" "}
                  · sends as {cfg.emailFrom}
                </>
              ) : (
                "e.g. mail.yourdomain.com — a subdomain keeps your main domain's email reputation isolated."
              )
            }
          >
            {s2 === "current" && (
              <form onSubmit={handleAdd} className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="sm:col-span-2 space-y-1.5">
                    <Label htmlFor="resend-domain">Sending subdomain</Label>
                    <Input
                      id="resend-domain"
                      value={domainName}
                      onChange={(e) => setDomainName(e.target.value)}
                      placeholder="mail.yourdomain.com"
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <p className="text-[11px] text-muted-foreground">
                      Use a subdomain (e.g. <code>mail.acme.com</code>), not
                      your root domain — it keeps your main domain&apos;s
                      reputation isolated, and your normal company email is
                      untouched.
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="resend-from-name">
                      From name (optional)
                    </Label>
                    <Input
                      id="resend-from-name"
                      value={fromName}
                      onChange={(e) => setFromName(e.target.value)}
                      placeholder={subAccount?.name ?? "Your business"}
                      autoComplete="off"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="resend-from-local">Send-from mailbox</Label>
                    <Input
                      id="resend-from-local"
                      value={fromLocalPart}
                      onChange={(e) => setFromLocalPart(e.target.value)}
                      placeholder="hello"
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <p className="text-[11px] text-muted-foreground">
                      The part before the @. Defaults to <code>hello</code>.
                    </p>
                  </div>
                </div>
                <Button type="submit" size="sm" disabled={adding}>
                  {adding ? (
                    <>
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                      Registering…
                    </>
                  ) : (
                    "Add domain & get DNS records"
                  )}
                </Button>
              </form>
            )}
          </Step>

          {/* Step 3: DNS records + verify */}
          <Step
            index={3}
            state={s3}
            title="Add DNS records & verify"
            summary={
              s3 === "done"
                ? "DNS checks passed."
                : s3 === "current"
                  ? "Add these at your DNS provider (Cloudflare, GoDaddy, …), then verify. Propagation can take a few minutes."
                  : "Copy-paste records at your DNS provider."
            }
          >
            {s3 === "current" && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Label
                    htmlFor="dns-provider"
                    className="text-xs text-muted-foreground"
                  >
                    Where is your domain&apos;s DNS hosted?
                  </Label>
                  <select
                    id="dns-provider"
                    value={providerId}
                    onChange={(e) => pickProvider(e.target.value)}
                    className="h-8 rounded-md border bg-background px-2 text-xs [&_option]:bg-background [&_option]:text-foreground"
                  >
                    {DNS_PROVIDERS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </div>
                <ProviderGuidance
                  provider={provider}
                  showMxTip={records.some(
                    (r) => r.type.toUpperCase() === "MX",
                  )}
                />
                {records.length > 0 ? (
                  // Every sending record Resend returns, including the return-path MX
                  // (feedback-smtp...) that verification needs. Only the step-5 receiving MX is excluded.
                  records
                    .filter(
                      (r) =>
                        r.type.toUpperCase() !== "MX" ||
                        r.value.toLowerCase().includes("feedback-smtp"),
                    )
                    .map((r, i) => (
                      <div
                        key={`${r.type}-${r.name}-${i}`}
                        className="space-y-2 rounded-lg border bg-muted/30 p-3"
                      >
                        <div className="flex items-center gap-2 text-xs font-medium text-foreground">
                          <span className="rounded bg-background px-1.5 py-0.5 uppercase tracking-wide">
                            {r.type}
                          </span>
                          {r.record && (
                            <span className="text-muted-foreground">
                              {r.record}
                            </span>
                          )}
                          <RecordStatusChip status={r.status} />
                        </div>
                        <DnsRecordFields record={r} />
                      </div>
                    ))
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Loading records…{" "}
                    <button
                      type="button"
                      className="underline underline-offset-2"
                      onClick={() => void loadRecords()}
                    >
                      refresh
                    </button>
                  </p>
                )}
                <div className="flex items-center gap-3">
                  <Button
                    type="button"
                    size="sm"
                    disabled={verifying}
                    onClick={handleVerify}
                  >
                    {verifying ? (
                      <>
                        <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                        Checking…
                      </>
                    ) : (
                      "Verify domain"
                    )}
                  </Button>
                  <p className="text-[11px] text-muted-foreground">
                    Statuses refresh automatically every 15s — once the
                    records are added you can just wait. Clicking Verify
                    re-runs the whole check (statuses reset to pending while
                    it runs).
                  </p>
                </div>
              </div>
            )}
          </Step>

          {/* Step 4: Verified */}
          <Step
            index={4}
            state={s4}
            title="Domain verified"
            summary={
              verified ? (
                <>
                  This sub-account&apos;s email now sends from{" "}
                  <span className="font-medium text-foreground">
                    {cfg?.domainName}
                  </span>
                  .
                </>
              ) : (
                "Sending flips from the shared sender to your domain."
              )
            }
          />

          {/* Step 5: Two-way inbox (optional) */}
          <Step
            index={5}
            state={s5}
            title="Two-way email inbox"
            optional
            summary={
              inboxOn
                ? "Replies land in Conversations and count for wait-for-reply workflow steps."
                : "Route replies into the Conversations inbox instead of your Reply-To address — they'll thread on the contact, notify the team, and count for wait-for-reply workflow steps."
            }
          >
            {(s5 === "current" || inboxOn) && (
              <div className="space-y-3">
                {!inboxOn ? (
                  <Button
                    type="button"
                    size="sm"
                    disabled={inboxBusy}
                    onClick={() => void handleInboxToggle(true)}
                  >
                    {inboxBusy ? (
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    ) : null}
                    Enable inbox
                  </Button>
                ) : (
                  <>
                    <div className="space-y-2">
                      <p className="text-[11px] text-muted-foreground">
                        Replies are captured at
                      </p>
                      <CopyValue value={`replies@${cfg?.domainName ?? ""}`} />
                      {inboxMxRecords.length > 0 ? (
                        <>
                          <p className="text-[11px] text-muted-foreground">
                            One more DNS record — this MX row tells the
                            internet to deliver mail for your subdomain here
                            (alongside the records from step 3).{" "}
                            {provider.id !== "other" && (
                              <>In {provider.label}: {provider.mxTip}</>
                            )}
                          </p>
                          {inboxMxRecords.map((r, i) => (
                            <div
                              key={`mx-${i}`}
                              className="space-y-2 rounded-lg border bg-background/60 p-3"
                            >
                              <div className="flex items-center gap-2 text-xs font-medium text-foreground">
                                <span className="rounded bg-background px-1.5 py-0.5 uppercase tracking-wide">
                                  MX
                                </span>
                                <RecordStatusChip status={r.status} />
                              </div>
                              <DnsRecordFields record={r} />
                            </div>
                          ))}
                        </>
                      ) : (
                        <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
                          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                          Add the MX record shown in your Resend dashboard for
                          this domain so replies can arrive.
                        </p>
                      )}
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={inboxBusy}
                      onClick={() => void handleInboxToggle(false)}
                    >
                      {inboxBusy ? (
                        <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                      ) : null}
                      Disable inbox
                    </Button>
                  </>
                )}
              </div>
            )}
          </Step>

          {/* Step 6: Open & click tracking (optional) */}
          <Step
            index={6}
            state={s6}
            title="Open & click tracking"
            optional
            summary={
              trackingOn
                ? "Broadcasts report opens and link clicks, and workflows can trigger on them."
                : "Report opens and link clicks on broadcasts (and trigger workflows from them). Off by default: click tracking routes links through the email provider's tracking host, which some senders prefer to avoid."
            }
          >
            {(s6 === "current" || trackingOn) && (
              <div className="space-y-2">
                <p className="text-[11px] text-muted-foreground">
                  Applies to every email sent from this domain. Delivery and
                  bounce reporting work either way; only opens and clicks need
                  this.
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant={trackingOn ? "outline" : "default"}
                  disabled={trackingBusy}
                  onClick={() => void handleTrackingToggle(!trackingOn)}
                >
                  {trackingBusy ? (
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  ) : null}
                  {trackingOn ? "Disable tracking" : "Enable tracking"}
                </Button>
              </div>
            )}
          </Step>

          {/* Footer: remove domain */}
          {cfg && (
            <div className="mt-1 flex items-center justify-end border-t pt-4">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={removing || verifying}
                onClick={handleRemove}
              >
                {removing ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Trash2 className="mr-1 h-3.5 w-3.5" />
                )}
                Remove domain
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
