import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Unsubscribe tokens: `${contactId}.${HMAC-SHA256(contactId, AUTOMATIONS_TOKEN_SECRET)}`.
 * Self-contained, so no token rows to look up. Rotating the secret kills every
 * outstanding link.
 */

function getSecret(): string {
  const s = process.env.AUTOMATIONS_TOKEN_SECRET;
  if (!s || s.length < 16) {
    throw new Error(
      "AUTOMATIONS_TOKEN_SECRET is not set (or too short). Generate one with `openssl rand -base64 32`.",
    );
  }
  return s;
}

export function signUnsubscribeToken(contactId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(contactId)) {
    // We split on ".", so a contact id containing one would never verify.
    // Firestore auto-ids never do.
    throw new Error("Unexpected contactId format for unsubscribe token");
  }
  const sig = createHmac("sha256", getSecret()).update(contactId).digest("hex");
  return `${contactId}.${sig}`;
}

/** Returns the contactId, or null. Timing-safe compare. */
export function verifyUnsubscribeToken(token: string): string | null {
  const dot = token.indexOf(".");
  if (dot < 1) return null;
  const contactId = token.slice(0, dot);
  let expected: string;
  try {
    expected = signUnsubscribeToken(contactId);
  } catch {
    return null;
  }
  if (token.length !== expected.length) return null;
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  return timingSafeEqual(a, b) ? contactId : null;
}

/**
 * "" when NEXT_PUBLIC_APP_URL isn't set. The email still renders with a broken
 * link, which we'd rather notice in dev than crash the send.
 */
export function buildUnsubscribeUrl(contactId: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (!base) return "";
  return `${base}/u/${signUnsubscribeToken(contactId)}`;
}
