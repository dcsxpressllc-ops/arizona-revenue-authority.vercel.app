import "server-only";

import { Resend } from "resend";

import { resolveCustomBrand } from "@/lib/landing/resolve-brand";
import { recordUsage } from "@/lib/server/usage-meter";
import type { ResendConfig } from "@/types/tenancy";
import { runAfterResponse } from "@/lib/server/after-response";

let _client: Resend | null = null;

export function getResend(): Resend {
  if (!_client) {
    const key = process.env.RESEND_API_KEY;
    if (!key) {
      throw new Error(
        "RESEND_API_KEY is not set. Add it to .env.local to enable email.",
      );
    }
    _client = new Resend(key);
  }
  return _client;
}

export function emailIsConfigured(): boolean {
  // trim() so a blank env var doesn't count as configured.
  return (
    !!process.env.RESEND_API_KEY?.trim() && !!process.env.EMAIL_FROM?.trim()
  );
}

/**
 * The tenant's own From address, only when the agency gate is on and the domain
 * is verified; otherwise undefined and sendEmail uses EMAIL_FROM. Checking the
 * gate too means flipping it off reverts to the shared sender immediately,
 * before any cleanup write. Pass straight into `sendEmail({ ..., from })`.
 */
export function tenantFrom(
  sub?: {
    resendConfig?: ResendConfig | null;
    emailDomainEnabledByAgency?: boolean;
  } | null,
): string | undefined {
  if (sub?.emailDomainEnabledByAgency !== true) return undefined;
  const cfg = sub.resendConfig;
  return cfg && cfg.status === "verified" ? cfg.emailFrom : undefined;
}

/**
 * Last-resort Reply-To: agency `supportEmail`, else CUSTOM_BRAND.supportEmail.
 * Otherwise replies go to From, usually a send-only domain with no MX, and
 * vanish. Cached 10 minutes per instance; failures give undefined rather than
 * blocking the send.
 */
let _replyToCache: { value: string | undefined; at: number } | null = null;
async function defaultReplyTo(): Promise<string | undefined> {
  const now = Date.now();
  if (_replyToCache && now - _replyToCache.at < 10 * 60 * 1000) {
    return _replyToCache.value;
  }
  let value: string | undefined;
  try {
    const brand = await resolveCustomBrand();
    value = brand.supportEmail?.trim() || undefined;
  } catch {
    value = undefined;
  }
  _replyToCache = { value, at: now };
  return value;
}

export async function sendEmail({
  to,
  subject,
  text,
  html,
  replyTo,
  from,
  subAccount,
  attachments,
  headers,
  meter,
}: {
  to: string;
  subject: string;
  /** Required so non-HTML clients still get content. */
  text: string;
  /** Resend prefers html when present. */
  html?: string;
  /**
   * Explicit Reply-To for when a narrower address is right (invites: the inviter;
   * contact sends: the operator). Otherwise subAccount.replyToEmail, then the
   * support address, so nothing goes out with a bouncing Reply-To.
   */
  replyTo?: string;
  /** Tenant sender from `tenantFrom`. Omit for platform mail to use EMAIL_FROM. */
  from?: string;
  /** Whose `replyToEmail` answers replies (see `replyTo`). */
  subAccount?: { replyToEmail?: string | null } | null;
  /**
   * When set, a successful send counts toward the workspace's monthly
   * `emailsSent`. Deployment mail (invites, billing, magic links) isn't metered.
   * Blocking happens at the callers that should block; transactional mail is
   * metered but never refused.
   */
  meter?: { subAccountId: string } | null;
  /** e.g. booking ICS. Base64 unless plain text, per Resend's contract. */
  attachments?: { filename: string; content: string; contentType?: string }[];
  /** e.g. In-Reply-To / References for threading. */
  headers?: Record<string, string>;
}): Promise<{ id: string }> {
  const resolvedFrom = from ?? process.env.EMAIL_FROM;
  if (!resolvedFrom) {
    throw new Error(
      "EMAIL_FROM is not set. It must be a sender on a Resend-verified domain.",
    );
  }
  const resolvedReplyTo =
    replyTo?.trim() ||
    subAccount?.replyToEmail?.trim() ||
    (await defaultReplyTo());
  const client = getResend();
  const result = await client.emails.send({
    from: resolvedFrom,
    to,
    subject,
    text,
    ...(html ? { html } : {}),
    replyTo: resolvedReplyTo,
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
    ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
  });
  if (result.error) {
    throw new Error(result.error.message || "Resend send failed");
  }
  if (!result.data?.id) {
    throw new Error("Resend send failed: no message id returned");
  }
  if (meter?.subAccountId) {
    runAfterResponse(() => recordUsage({
      subAccountId: meter.subAccountId,
      unit: "emailsSent",
      qty: 1,
    }));
  }
  return { id: result.data.id };
}

/**
 * Same plain-text email to many recipients as individual messages (own To:,
 * no CC/BCC leakage) via Resend's batch API, 100 per call. A failed chunk is
 * counted as failed and the rest carry on.
 */
export async function sendPlainTextBroadcast({
  recipients,
  subject,
  text,
  from,
  replyTo,
  replyToFor,
}: {
  recipients: string[];
  subject: string;
  text: string;
  from?: string;
  replyTo?: string;
  /** Per-recipient Reply-To (e.g. `replies+<thread>@...`). Falls back to `replyTo` when it returns nothing. */
  replyToFor?: (to: string) => string | undefined | null;
}): Promise<{
  sent: number;
  failed: number;
  errors: string[];
  /** Recipients in chunks Resend accepted. */
  sentTo: string[];
}> {
  const resolvedFrom = from ?? process.env.EMAIL_FROM;
  if (!resolvedFrom) {
    throw new Error(
      "EMAIL_FROM is not set. It must be a sender on a Resend-verified domain.",
    );
  }
  const client = getResend();
  let sent = 0;
  let failed = 0;
  const errors: string[] = [];
  const sentTo: string[] = [];

  for (let i = 0; i < recipients.length; i += 100) {
    const chunk = recipients.slice(i, i + 100);
    try {
      const res = await client.batch.send(
        chunk.map((to) => {
          const perRecipient = replyToFor?.(to) || replyTo;
          return {
            from: resolvedFrom,
            to,
            subject,
            text,
            ...(perRecipient ? { replyTo: perRecipient } : {}),
          };
        }),
      );
      if (res.error) {
        failed += chunk.length;
        errors.push(res.error.message ?? "Resend batch error");
      } else {
        sent += chunk.length;
        sentTo.push(...chunk);
      }
    } catch (err) {
      failed += chunk.length;
      errors.push(err instanceof Error ? err.message : "Unknown batch error");
    }
  }

  return { sent, failed, errors: errors.slice(0, 5), sentTo };
}
