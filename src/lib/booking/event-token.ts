import "server-only";

import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Public-share tokens for calendar events, same contract as quotes/token.ts:
 *
 *   `${eventId}.${nonce}.${HMAC-SHA256(`${eventId}.${nonce}`, SECRET)}`
 *
 * Issued at booking and rotated on every reschedule so old links die. Only the
 * SHA-256 is stored (`event.publicTokenHash`); the raw token appears once, in
 * the confirmation email. Rotating AUTOMATIONS_TOKEN_SECRET also kills every
 * quote and unsubscribe link.
 */

const TOKEN_PARTS = 3;

function getSecret(): string {
  const s = process.env.AUTOMATIONS_TOKEN_SECRET;
  if (!s || s.length < 16) {
    throw new Error(
      "AUTOMATIONS_TOKEN_SECRET is not set (or too short). Generate one with `openssl rand -base64 32`.",
    );
  }
  return s;
}

/** Caller persists `hash`. */
export function issueEventToken(eventId: string): {
  token: string;
  hash: string;
} {
  if (!/^[A-Za-z0-9_-]+$/.test(eventId)) {
    throw new Error("Unexpected eventId format for event token");
  }
  const nonce = randomBytes(16).toString("hex");
  const payload = `${eventId}.${nonce}`;
  const sig = createHmac("sha256", getSecret()).update(payload).digest("hex");
  const token = `${payload}.${sig}`;
  return { token, hash: hashEventToken(token) };
}

/** Stored as `event.publicTokenHash`. */
export function hashEventToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Signature check only. Caller must load the event and confirm
 * `publicTokenHash === hash`, or a pre-reschedule token would still work.
 */
export function verifyEventToken(
  token: string,
): { eventId: string; hash: string } | null {
  const parts = token.split(".");
  if (parts.length !== TOKEN_PARTS) return null;
  const [eventId, nonce, presentedSig] = parts;
  if (!eventId || !nonce || !presentedSig) return null;

  let expectedSig: string;
  try {
    expectedSig = createHmac("sha256", getSecret())
      .update(`${eventId}.${nonce}`)
      .digest("hex");
  } catch {
    return null;
  }
  if (presentedSig.length !== expectedSig.length) return null;
  if (
    !timingSafeEqual(Buffer.from(presentedSig), Buffer.from(expectedSig))
  ) {
    return null;
  }
  return { eventId, hash: hashEventToken(token) };
}

/** "" when NEXT_PUBLIC_APP_URL is unset. */
export function buildEventPublicUrl(token: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (!base) return "";
  return `${base}/e/${token}`;
}
