import "server-only";

import { createHmac, timingSafeEqual } from "crypto";
import sanitizeHtml from "sanitize-html";
import type { ResendConfig, SubAccountDoc } from "@/types";

/**
 * Two-way email via Resend Inbound. The verified sending domain also receives
 * (Resend `capabilities.receiving` + an MX record). Outbound sends set Reply-To
 * to a capture address on that domain; replies fire the account-wide
 * `email.received` webhook (/api/webhooks/resend/inbound), which only carries
 * metadata, so the body is fetched via GET /emails/receiving/{id}.
 */

/** Fixed; not configurable. */
const REPLY_LOCAL_PART = "replies";

/** Thread bubble, not an archive. The raw email stays on Resend. */
const MAX_TEXT_CHARS = 20_000;
const MAX_HTML_CHARS = 60_000;

export function emailInboxWebhookConfigured(): boolean {
  return !!process.env.RESEND_WEBHOOK_SECRET;
}

/** Agency gate on, domain verified, operator opted in. Strict `=== true`, so missing fields mean off. */
export function emailInboxEnabled(
  sub?: Pick<
    SubAccountDoc,
    "resendConfig" | "emailDomainEnabledByAgency"
  > | null,
): boolean {
  if (sub?.emailDomainEnabledByAgency !== true) return false;
  const cfg = sub.resendConfig;
  return !!cfg && cfg.status === "verified" && cfg.inboxEnabled === true;
}

/** With a contactId, plus-addressing ties the reply to that contact even through forwards or a changed sender. */
export function inboundReplyAddress(
  cfg: Pick<ResendConfig, "domainName">,
  contactId?: string | null,
): string {
  return contactId
    ? `${REPLY_LOCAL_PART}+${contactId}@${cfg.domainName}`
    : `${REPLY_LOCAL_PART}@${cfg.domainName}`;
}

/** Per-contact capture address when the inbox is on, otherwise the caller's fallback unchanged. */
export function resolveThreadedReplyTo(
  sub:
    | Pick<SubAccountDoc, "resendConfig" | "emailDomainEnabledByAgency">
    | null
    | undefined,
  contactId: string | null | undefined,
  fallback: string | undefined,
): string | undefined {
  if (emailInboxEnabled(sub) && sub?.resendConfig) {
    return inboundReplyAddress(sub.resendConfig, contactId ?? null);
  }
  return fallback;
}

/** Domain + plus-addressed contactId, or null if it isn't one of our capture addresses. */
export function parseCaptureAddress(
  raw: string,
): { domain: string; contactId: string | null } | null {
  // Handle "Name <a@b.c>" here. Don't use bareEmailAddress(): it lowercases and
  // would corrupt the plus-tag.
  const angle = raw.match(/<([^<>]+)>/);
  const address = (angle ? angle[1] : raw).trim();
  const at = address.lastIndexOf("@");
  if (at < 0) return null;
  // The tag is a case-sensitive Firestore id. Match the local part
  // case-insensitively but keep the tag's casing. If something lowercased the
  // whole address, the lookup misses and the sender-email fallback still threads it.
  const local = address.slice(0, at);
  const localLower = local.toLowerCase();
  const domain = address.slice(at + 1).toLowerCase().trim();
  if (!domain) return null;
  if (localLower === REPLY_LOCAL_PART) return { domain, contactId: null };
  if (localLower.startsWith(`${REPLY_LOCAL_PART}+`)) {
    const contactId = local.slice(REPLY_LOCAL_PART.length + 1).trim();
    return { domain, contactId: contactId || null };
  }
  return null;
}

/** Lowercased bare address from "Name <a@b.c>" or "a@b.c". */
export function bareEmailAddress(raw: string): string {
  const match = raw.match(/<([^<>]+)>/);
  const addr = (match ? match[1] : raw).trim().toLowerCase();
  return addr;
}

/** Heuristic bounce/auto-reply detection. These never create a contact or resume wait_for_reply. */
export function looksLikeAutoMail(input: {
  from: string;
  subject: string;
  headers?: Record<string, string> | null;
}): boolean {
  const from = bareEmailAddress(input.from);
  if (
    /^(mailer-daemon|postmaster|no-?reply|donotreply|bounce)[@+.-]/.test(from)
  ) {
    return true;
  }
  const headers = input.headers ?? {};
  const auto = Object.entries(headers).find(
    ([k]) => k.toLowerCase() === "auto-submitted",
  );
  if (auto && auto[1].toLowerCase() !== "no") return true;
  const subject = input.subject.toLowerCase();
  return (
    subject.startsWith("out of office") ||
    subject.startsWith("automatic reply") ||
    subject.startsWith("auto-reply") ||
    subject.startsWith("delivery status notification") ||
    subject.startsWith("undeliverable")
  );
}

/** null when empty. */
export function sanitizeInboundHtml(html: string | null | undefined): string | null {
  if (!html) return null;
  const clean = sanitizeHtml(html, {
    allowedTags: [
      "a", "b", "strong", "i", "em", "u", "p", "br", "div", "span",
      "blockquote", "ul", "ol", "li", "h1", "h2", "h3", "h4",
      "table", "thead", "tbody", "tr", "td", "th", "pre", "code", "hr",
    ],
    allowedAttributes: { a: ["href"] },
    allowedSchemes: ["http", "https", "mailto"],
  }).trim();
  if (!clean) return null;
  return clean.length > MAX_HTML_CHARS ? clean.slice(0, MAX_HTML_CHARS) : clean;
}

export function capInboundText(text: string | null | undefined): string {
  const t = (text ?? "").trim();
  return t.length > MAX_TEXT_CHARS ? t.slice(0, MAX_TEXT_CHARS) : t;
}

/**
 * Resend webhook check (Svix scheme, hand-rolled to avoid a dependency).
 * HMAC-SHA256 over `${svix-id}.${svix-timestamp}.${rawBody}` keyed with the
 * base64-decoded part of the `whsec_` secret, compared against the `v1,<sig>`
 * entries in `svix-signature`. Timestamps more than 5 minutes off are rejected.
 */
export function verifyResendWebhook(input: {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
  rawBody: string;
  secret: string;
}): boolean {
  const { id, timestamp, signature, rawBody, secret } = input;
  if (!id || !timestamp || !signature) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const skewSeconds = Math.abs(Date.now() / 1000 - ts);
  if (skewSeconds > 300) return false;

  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  if (key.length === 0) return false;

  const expected = createHmac("sha256", key)
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest();

  return signature.split(" ").some((part) => {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) return false;
    let candidate: Buffer;
    try {
      candidate = Buffer.from(sig, "base64");
    } catch {
      return false;
    }
    return (
      candidate.length === expected.length &&
      timingSafeEqual(candidate, expected)
    );
  });
}

/** The parts of Resend's received-email response we use. */
export interface ReceivedEmail {
  id: string;
  from: string;
  to: string[];
  subject: string;
  text: string | null;
  html: string | null;
  messageId: string | null;
  headers: Record<string, string>;
}

/**
 * Full content of a received email. null on failure; the route logs and still
 * 200s so Resend doesn't retry-storm, and the email stays on Resend.
 */
export async function fetchReceivedEmail(
  emailId: string,
): Promise<ReceivedEmail | null> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch(
      `https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!res.ok) {
      console.warn(`[email-inbox] received-email fetch ${res.status} for ${emailId}`);
      return null;
    }
    const data = (await res.json()) as Record<string, unknown>;
    const headersRaw = data.headers;
    const headers: Record<string, string> = {};
    if (headersRaw && typeof headersRaw === "object") {
      for (const [k, v] of Object.entries(headersRaw as Record<string, unknown>)) {
        if (typeof v === "string") headers[k] = v;
      }
    }
    return {
      id: String(data.id ?? emailId),
      from: String(data.from ?? ""),
      to: Array.isArray(data.to) ? data.to.map(String) : [],
      subject: String(data.subject ?? ""),
      text: typeof data.text === "string" ? data.text : null,
      html: typeof data.html === "string" ? data.html : null,
      messageId:
        typeof data.message_id === "string" ? data.message_id : null,
      headers,
    };
  } catch (err) {
    console.warn(`[email-inbox] received-email fetch failed for ${emailId}`, err);
    return null;
  }
}
