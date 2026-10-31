"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Loader2, Phone } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";

/**
 * "Phone dialer" settings card (Messaging tab, admin-only). Enable provisions a
 * Twilio API Key + TwiML App on the sub-account's own Twilio account, after which
 * members can call from contact profiles with the sub-account number as caller ID.
 * Recording is a separate opt-in, off by default (consent laws vary by region).
 */
export function SubAccountDialerSection() {
  const { subAccountId, subAccount, isAdmin } = useSubAccount();
  const [busy, setBusy] = useState(false);

  if (!isAdmin) return null;

  const twilioReady = subAccount?.twilioConfig?.enabled === true;
  const cfg = subAccount?.dialerConfig ?? null;
  const enabled = cfg?.enabled === true;
  const recording = cfg?.recordCalls === true;

  async function callApi(
    method: "POST" | "PATCH" | "DELETE",
    body?: Record<string, unknown>,
    okMessage?: string,
  ) {
    setBusy(true);
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/dialer`, {
        method,
        ...(body
          ? {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }
          : {}),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "Request failed.");
      }
      if (okMessage) toast.success(okMessage);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border bg-card p-6">
      <header className="mb-4 flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-teal-500/10 text-teal-600 dark:text-teal-400">
          <Phone className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold">Phone dialer</h2>
            <span className="rounded-full bg-fuchsia-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-fuchsia-600 dark:text-fuchsia-400">
              Beta
            </span>
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Call contacts from the browser through your own Twilio account —
            your dedicated number shows as caller ID, and each call logs to the
            contact&apos;s activity timeline. Outbound only: your number&apos;s
            inbound setup (AI Voice / missed-call text-back) is untouched.
          </p>
        </div>
      </header>

      {!twilioReady ? (
        <p className="rounded-lg border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground">
          Set up your dedicated Twilio number first (Settings → SMS above) —
          the dialer places calls through that account. Calls bill to your
          Twilio at their standard per-minute rate.
        </p>
      ) : !enabled ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            Enabling creates a calling app + API key on your Twilio account.
            No extra services, no monthly fee — per-minute Twilio rates only.
          </p>
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() => void callApi("POST", undefined, "Dialer enabled. The Call button now shows on contact profiles.")}
          >
            {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
            Enable dialer
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={recording}
              disabled={busy}
              onChange={(e) =>
                void callApi(
                  "PATCH",
                  { recordCalls: e.target.checked },
                  e.target.checked
                    ? "Call recording on."
                    : "Call recording off.",
                )
              }
            />
            <span>
              <span className="font-medium">Record calls</span>
              <span className="block text-xs text-muted-foreground">
                Dual-channel, from answer. Off by default — recording-consent
                laws vary by region; confirm your obligations before turning
                this on. Recording links appear on the call&apos;s activity
                entry (opening them requires your Twilio login).
              </span>
            </span>
          </label>
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              Members place calls from the Call button on any contact with a
              phone number. Contacts marked &quot;opted out of calls&quot; are
              blocked.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                if (
                  confirm(
                    "Disable the dialer? The calling app + API key are removed from your Twilio account and the Call button disappears.",
                  )
                ) {
                  void callApi("DELETE", undefined, "Dialer disabled.");
                }
              }}
            >
              Disable
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
