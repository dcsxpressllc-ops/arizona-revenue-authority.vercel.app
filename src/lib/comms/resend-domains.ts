import "server-only";

import { getResend } from "./resend";
import type { ResendConfig } from "@/types";

/**
 * Per-sub-account sending domains on one shared Resend account. Functions
 * return { ok, error } rather than throwing, so a Resend hiccup shows as a
 * friendly message instead of a 500.
 */

/** A DNS record the tenant must add. Display only, never persisted. */
export interface DnsRecord {
  /** e.g. "SPF" / "DKIM". */
  record: string;
  name: string;
  type: string;
  value: string;
  ttl?: string;
  priority?: number;
  status?: string;
}

/**
 * Suffixes where the registrable domain is the last three labels (acme.com.au),
 * so acme.com.au is still a root. Not exhaustive; AU first since that's the main
 * market. Anything else is treated as a single-label TLD.
 */
const MULTI_PART_SUFFIXES = new Set([
  "com.au",
  "net.au",
  "org.au",
  "edu.au",
  "gov.au",
  "id.au",
  "asn.au",
  "co.uk",
  "org.uk",
  "me.uk",
  "ltd.uk",
  "plc.uk",
  "co.nz",
  "net.nz",
  "org.nz",
  "com.br",
  "com.sg",
  "com.my",
  "co.za",
  "co.jp",
  "co.in",
  "co.id",
]);

function registrableLabelCount(labels: string[]): number {
  const lastTwo = labels.slice(-2).join(".");
  return MULTI_PART_SUFFIXES.has(lastTwo) ? 3 : 2;
}

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export interface SubdomainValidation {
  ok: boolean;
  /** Lower-cased host with scheme/path/@ stripped. */
  domain: string;
  error: string | null;
}

/**
 * Require a subdomain (e.g. mail.acme.com), not the root. It keeps the tenant's
 * sending reputation separate from their main domain, as Resend recommends.
 */
export function validateSendingSubdomain(input: string): SubdomainValidation {
  const fail = (error: string): SubdomainValidation => ({
    ok: false,
    domain: "",
    error,
  });

  const domain = (input ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\.$/, "");

  if (!domain) return fail("Enter a domain.");
  if (domain.includes("@")) {
    return fail("Enter a domain, not an email address — e.g. mail.acme.com.");
  }

  const labels = domain.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL_RE.test(l))) {
    return fail("Enter a valid domain, e.g. mail.acme.com.");
  }

  if (labels.length <= registrableLabelCount(labels)) {
    return fail(
      "Use a subdomain, not your root domain — e.g. mail.acme.com instead of acme.com. A dedicated subdomain protects your main domain's email reputation.",
    );
  }

  return { ok: true, domain, error: null };
}

/** Resend status to our 3-state ResendConfig.status. */
function mapStatus(resendStatus: string | undefined): ResendConfig["status"] {
  if (resendStatus === "verified") return "verified";
  if (resendStatus === "failed") return "failed";
  return "pending";
}

function toDnsRecords(records: unknown): DnsRecord[] {
  if (!Array.isArray(records)) return [];
  return records.map((r) => {
    const rec = r as Record<string, unknown>;
    return {
      record: String(rec.record ?? ""),
      name: String(rec.name ?? ""),
      type: String(rec.type ?? ""),
      value: String(rec.value ?? ""),
      ttl: rec.ttl != null ? String(rec.ttl) : undefined,
      priority:
        typeof rec.priority === "number" ? rec.priority : undefined,
      status: rec.status != null ? String(rec.status) : undefined,
    };
  });
}

function errMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export interface CreateDomainResult {
  ok: boolean;
  domainId: string | null;
  status: ResendConfig["status"];
  records: DnsRecord[];
  error: string | null;
}

/** Returns the domain id and DNS records. */
export async function createSendingDomain(
  name: string,
): Promise<CreateDomainResult> {
  try {
    const { data, error } = await getResend().domains.create({ name });
    if (error || !data?.id) {
      return {
        ok: false,
        domainId: null,
        status: "failed",
        records: [],
        error: error?.message ?? "Resend did not return a domain id.",
      };
    }
    return {
      ok: true,
      domainId: data.id,
      status: mapStatus(data.status),
      records: toDnsRecords((data as { records?: unknown }).records),
      error: null,
    };
  } catch (err) {
    return {
      ok: false,
      domainId: null,
      status: "failed",
      records: [],
      error: errMessage(err, "Failed to register the domain with Resend."),
    };
  }
}

export interface DomainStatusResult {
  ok: boolean;
  status: ResendConfig["status"];
  records: DnsRecord[];
  error: string | null;
}

export async function getSendingDomain(
  domainId: string,
): Promise<DomainStatusResult> {
  try {
    const { data, error } = await getResend().domains.get(domainId);
    if (error || !data) {
      return {
        ok: false,
        status: "failed",
        records: [],
        error: error?.message ?? "Domain not found on Resend.",
      };
    }
    return {
      ok: true,
      status: mapStatus(data.status),
      records: toDnsRecords((data as { records?: unknown }).records),
      error: null,
    };
  } catch (err) {
    return {
      ok: false,
      status: "failed",
      records: [],
      error: errMessage(err, "Failed to read the domain status from Resend."),
    };
  }
}

/** Ask Resend to re-check DNS, then read back. Verification is async, so this may still say "pending". */
export async function verifySendingDomain(
  domainId: string,
): Promise<DomainStatusResult> {
  try {
    const { error } = await getResend().domains.verify(domainId);
    if (error) {
      return {
        ok: false,
        status: "pending",
        records: [],
        error: error.message,
      };
    }
  } catch (err) {
    return {
      ok: false,
      status: "pending",
      records: [],
      error: errMessage(err, "Failed to trigger verification on Resend."),
    };
  }
  return getSendingDomain(domainId);
}

/**
 * Open + click tracking for a domain, both together: opens use a pixel,
 * clicks rewrite links through the provider's tracking host. Raw REST
 * (PATCH /domains/{id}).
 */
export async function setDomainTracking(
  domainId: string,
  enabled: boolean,
): Promise<{ ok: boolean; error: string | null }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { ok: false, error: "RESEND_API_KEY is not set." };
  try {
    const res = await fetch(
      `https://api.resend.com/domains/${encodeURIComponent(domainId)}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          open_tracking: enabled,
          click_tracking: enabled,
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!res.ok) {
      let message = `Resend returned ${res.status}.`;
      try {
        const data = (await res.json()) as { message?: string };
        if (data?.message) message = data.message;
      } catch {
        // non-JSON error body; keep the status message
      }
      return { ok: false, error: message };
    }
    return { ok: true, error: null };
  } catch (err) {
    return {
      ok: false,
      error: errMessage(err, "Failed to update tracking on Resend."),
    };
  }
}

/**
 * Turn on receiving for a domain. Raw REST (PATCH /domains/{id}) because older
 * SDK versions don't know `capabilities`. Sending stays on; the inbound MX
 * records then show up via getSendingDomain.
 */
export async function enableDomainReceiving(
  domainId: string,
): Promise<{ ok: boolean; error: string | null }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { ok: false, error: "RESEND_API_KEY is not set." };
  try {
    const res = await fetch(
      `https://api.resend.com/domains/${encodeURIComponent(domainId)}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          capabilities: { sending: "enabled", receiving: "enabled" },
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!res.ok) {
      let message = `Resend returned ${res.status}.`;
      try {
        const data = (await res.json()) as { message?: string };
        if (data?.message) message = data.message;
      } catch {
        // non-JSON error body; keep the status message
      }
      return { ok: false, error: message };
    }
    return { ok: true, error: null };
  } catch (err) {
    return {
      ok: false,
      error: errMessage(err, "Failed to enable receiving on Resend."),
    };
  }
}

/** Best-effort, for offboarding or re-adding. */
export async function removeSendingDomain(
  domainId: string,
): Promise<{ ok: boolean; error: string | null }> {
  try {
    const { error } = await getResend().domains.remove(domainId);
    return { ok: !error, error: error?.message ?? null };
  } catch (err) {
    return { ok: false, error: errMessage(err, "Failed to remove the domain.") };
  }
}
