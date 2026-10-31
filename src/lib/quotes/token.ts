import "server-only";

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Public-share tokens for quotes:
 *
 *   `${quoteId}.${nonce}.${HMAC-SHA256(`${quoteId}.${nonce}`, SECRET)}`
 *
 * The random nonce makes every re-send issue a fresh token, so an old leaked
 * link dies once `publicTokenHash` is replaced. Only the SHA-256 hash is
 * stored; the raw token exists only in the email URL, so a DB dump can't forge
 * accept/decline requests.
 *
 * Shares AUTOMATIONS_TOKEN_SECRET with unsubscribe links: rotating it
 * invalidates every outstanding quote link too.
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

/** Call only on send/re-send. The caller persists the hash to `quote.publicTokenHash`. */
export function issueQuoteToken(quoteId: string): {
  token: string;
  hash: string;
} {
  if (!/^[A-Za-z0-9_-]+$/.test(quoteId)) {
    // Firestore auto-IDs are alphanumeric; a "." would break the split on verify.
    throw new Error("Unexpected quoteId format for quote token");
  }
  const nonce = randomBytes(16).toString("hex");
  const payload = `${quoteId}.${nonce}`;
  const sig = createHmac("sha256", getSecret()).update(payload).digest("hex");
  const token = `${payload}.${sig}`;
  return { token, hash: hashQuoteToken(token) };
}

/** SHA-256 hex; what's stored on the quote doc. */
export function hashQuoteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Returns { quoteId, hash } or null on any failure. The caller still loads the
 * quote and checks `publicTokenHash === hash`. HMAC comparison is timing-safe.
 */
export function verifyQuoteToken(
  token: string,
): { quoteId: string; hash: string } | null {
  const parts = token.split(".");
  if (parts.length !== TOKEN_PARTS) return null;
  const [quoteId, nonce, presentedSig] = parts;
  if (!quoteId || !nonce || !presentedSig) return null;

  let expectedSig: string;
  try {
    expectedSig = createHmac("sha256", getSecret())
      .update(`${quoteId}.${nonce}`)
      .digest("hex");
  } catch {
    return null;
  }
  if (presentedSig.length !== expectedSig.length) return null;
  const a = Buffer.from(presentedSig);
  const b = Buffer.from(expectedSig);
  if (!timingSafeEqual(a, b)) return null;

  return { quoteId, hash: hashQuoteToken(token) };
}

/** Empty string when NEXT_PUBLIC_APP_URL is unset: a broken dev link beats a crashed send. */
export function buildQuoteUrl(token: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (!base) return "";
  return `${base}/q/${token}`;
}
