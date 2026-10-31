import "server-only";

import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Plan checkout-link tokens, same pattern as lib/quotes/token.ts:
 *
 *   `${subAccountId}.${nonce}.${HMAC-SHA256(`${subAccountId}.${nonce}`, SECRET)}`
 *
 * The nonce makes each link unique, so re-sending rotates the token and kills
 * the old link with no blacklist. Only the SHA-256 of the active token is stored
 * (`billing.checkoutTokenHash`), so a DB dump can't start a checkout. Usage
 * charges also keep `payUrl` server-side so reminders reuse the same link.
 * Rotating AUTOMATIONS_TOKEN_SECRET invalidates these along with quote and
 * unsubscribe links.
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

/** Caller persists the hash to `billing.checkoutTokenHash`. */
export function issueCheckoutToken(subAccountId: string): {
  token: string;
  hash: string;
} {
  if (!/^[A-Za-z0-9_-]+$/.test(subAccountId)) {
    throw new Error("Unexpected subAccountId format for checkout token");
  }
  const nonce = randomBytes(16).toString("hex");
  const payload = `${subAccountId}.${nonce}`;
  const sig = createHmac("sha256", getSecret()).update(payload).digest("hex");
  const token = `${payload}.${sig}`;
  return { token, hash: hashCheckoutToken(token) };
}

export function hashCheckoutToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Signature check only. Caller must still match the hash against `billing.checkoutTokenHash`. */
export function verifyCheckoutToken(
  token: string,
): { subAccountId: string; hash: string } | null {
  const parts = token.split(".");
  if (parts.length !== TOKEN_PARTS) return null;
  const [subAccountId, nonce, presentedSig] = parts;
  if (!subAccountId || !nonce || !presentedSig) return null;

  let expectedSig: string;
  try {
    expectedSig = createHmac("sha256", getSecret())
      .update(`${subAccountId}.${nonce}`)
      .digest("hex");
  } catch {
    return null;
  }
  if (presentedSig.length !== expectedSig.length) return null;
  if (!timingSafeEqual(Buffer.from(presentedSig), Buffer.from(expectedSig))) {
    return null;
  }

  return { subAccountId, hash: hashCheckoutToken(token) };
}

/** "" when NEXT_PUBLIC_APP_URL is unset. */
export function buildCheckoutUrl(token: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (!base) return "";
  return `${base}/pay/${token}`;
}

// One-time charge tokens (/pay/charge/[token])

/**
 * Like plan tokens, but with a `charge.` prefix in the HMAC payload so neither
 * kind can verify as the other. Payload id is the billingCharges doc id.
 */
export function issueChargeToken(chargeId: string): {
  token: string;
  hash: string;
} {
  if (!/^[A-Za-z0-9_-]+$/.test(chargeId)) {
    throw new Error("Unexpected chargeId format for charge token");
  }
  const nonce = randomBytes(16).toString("hex");
  const sig = createHmac("sha256", getSecret())
    .update(`charge.${chargeId}.${nonce}`)
    .digest("hex");
  const token = `${chargeId}.${nonce}.${sig}`;
  return { token, hash: hashCheckoutToken(token) };
}

/** Signature check only. Caller must still match the hash against the charge doc's `tokenHash`. */
export function verifyChargeToken(
  token: string,
): { chargeId: string; hash: string } | null {
  const parts = token.split(".");
  if (parts.length !== TOKEN_PARTS) return null;
  const [chargeId, nonce, presentedSig] = parts;
  if (!chargeId || !nonce || !presentedSig) return null;

  let expectedSig: string;
  try {
    expectedSig = createHmac("sha256", getSecret())
      .update(`charge.${chargeId}.${nonce}`)
      .digest("hex");
  } catch {
    return null;
  }
  if (presentedSig.length !== expectedSig.length) return null;
  if (!timingSafeEqual(Buffer.from(presentedSig), Buffer.from(expectedSig))) {
    return null;
  }

  return { chargeId, hash: hashCheckoutToken(token) };
}

/** "" when NEXT_PUBLIC_APP_URL is unset. */
export function buildChargeCheckoutUrl(token: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (!base) return "";
  return `${base}/pay/charge/${token}`;
}
