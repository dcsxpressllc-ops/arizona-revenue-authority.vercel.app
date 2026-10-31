"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Custom domain for Cloud-hosted deployments. Ships in the template but renders
 * nothing unless NEXT_PUBLIC_CLOUD === "1" (set only by the Cloud provisioner).
 * Server work goes through the owner-gated /api/cloud-instance/domain proxy.
 */

interface DomainStatus {
  customDomain: string | null;
  appUrl: string | null;
  state: "none" | "pending" | "live";
}

export function CloudDomainSection() {
  const isCloud = process.env.NEXT_PUBLIC_CLOUD === "1";
  const [status, setStatus] = useState<DomainStatus | null>(null);
  const [domain, setDomain] = useState("");
  const [cname, setCname] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/cloud-instance/domain", {
      cache: "no-store",
    });
    if (res.ok) setStatus((await res.json()) as DomainStatus);
  }, []);

  useEffect(() => {
    if (isCloud) void refresh();
  }, [isCloud, refresh]);

  useEffect(() => {
    if (!isCloud || status?.state !== "pending") return;
    const t = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(t);
  }, [isCloud, status?.state, refresh]);

  if (!isCloud) return null;

  async function submit() {
    setBusy(true);
    try {
      const res = await fetch("/api/cloud-instance/domain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain }),
      });
      const data = (await res.json()) as {
        error?: string;
        cnameTarget?: string;
      };
      if (!res.ok) {
        toast.error(data.error ?? "Couldn't add the domain");
        return;
      }
      setCname(data.cnameTarget ?? "cname.vercel-dns.com");
      toast.success("Domain added — now point your DNS at it");
      await refresh();
    } catch {
      toast.error("Network error — try again");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border bg-card p-5">
      <h2 className="text-sm font-semibold">Custom domain</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Serve your CRM from your own domain instead of{" "}
        {status?.appUrl ?? "your launch address"}. We recommend a subdomain
        like <code className="font-mono">crm.yourbusiness.com</code>.
      </p>

      {status?.state === "live" && status.customDomain ? (
        <p className="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm">
          Live on{" "}
          <span className="font-medium">https://{status.customDomain}</span>.
          Your old address redirects here automatically.
          <span className="mt-1 block text-xs text-muted-foreground">
            If you use Google Calendar sync, Meta, or Twilio webhooks,
            update the URLs registered in those consoles to the new domain.
          </span>
        </p>
      ) : status?.state === "pending" && status.customDomain ? (
        <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
          <p>
            Waiting for DNS on{" "}
            <span className="font-medium">{status.customDomain}</span>. Add
            this record at your domain provider:
          </p>
          <p className="mt-2 font-mono text-xs">
            CNAME&nbsp;&nbsp;{status.customDomain.split(".")[0]}
            &nbsp;&nbsp;→&nbsp;&nbsp;{cname ?? "cname.vercel-dns.com"}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            We check every few seconds; once DNS propagates your CRM
            switches over automatically (SSL included).
          </p>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Input
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="crm.yourbusiness.com"
            className="h-9 w-64"
          />
          <Button
            size="sm"
            disabled={busy || !domain.trim()}
            onClick={() => void submit()}
          >
            {busy ? "Adding…" : "Add domain"}
          </Button>
        </div>
      )}
    </section>
  );
}
