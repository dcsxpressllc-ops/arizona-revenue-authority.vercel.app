import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Stripe-style signatures: `LeadStack-Signature: t=<unix_ts>,v1=<hmac_hex>`,
 * HMAC-SHA256 over `${timestamp}.${rawBody}` with the subscription secret.
 *
 * Subscribers parse t and v1, reject if t is older than 5 minutes, then
 * recompute and constant-time compare. Signing the timestamp is what stops an
 * intercepted delivery being replayed forever.
 *
 * The `v1` prefix leaves room for a v2 scheme (emit both during a deprecation window).
 */

const SIGNING_VERSION = "v1";
const TOLERANCE_SECONDS = 5 * 60;

export function generateSigningSecret(): string {
  // 32 bytes = 64 hex chars, same as Stripe.
  return `whsec_${randomBytes(32).toString("hex")}`;
}

export interface SignedPayload {
  header: string;
  /** Unix seconds. */
  timestamp: number;
}

export function signWebhookPayload(
  secret: string,
  rawBody: string,
  now: Date = new Date(),
): SignedPayload {
  const timestamp = Math.floor(now.getTime() / 1000);
  const signedString = `${timestamp}.${rawBody}`;
  const hmac = createHmac("sha256", secret)
    .update(signedString, "utf8")
    .digest("hex");
  return {
    header: `t=${timestamp},${SIGNING_VERSION}=${hmac}`,
    timestamp,
  };
}

/** Reference verifier for our tests; /docs/api shows subscribers the same algorithm. */
export function verifyWebhookSignature(opts: {
  secret: string;
  rawBody: string;
  header: string | null;
  now?: Date;
}): { ok: boolean; reason?: string } {
  if (!opts.header) return { ok: false, reason: "missing_header" };
  const parts = opts.header.split(",").map((s) => s.trim());
  let timestampStr: string | null = null;
  let hmacStr: string | null = null;
  for (const part of parts) {
    if (part.startsWith("t=")) timestampStr = part.slice(2);
    if (part.startsWith(`${SIGNING_VERSION}=`)) {
      hmacStr = part.slice(SIGNING_VERSION.length + 1);
    }
  }
  if (!timestampStr || !hmacStr) return { ok: false, reason: "malformed_header" };
  const timestamp = Number(timestampStr);
  if (!Number.isFinite(timestamp)) {
    return { ok: false, reason: "malformed_timestamp" };
  }
  const now = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  if (Math.abs(now - timestamp) > TOLERANCE_SECONDS) {
    return { ok: false, reason: "timestamp_out_of_tolerance" };
  }
  const expectedHmac = createHmac("sha256", opts.secret)
    .update(`${timestamp}.${opts.rawBody}`, "utf8")
    .digest("hex");
  if (expectedHmac.length !== hmacStr.length) {
    return { ok: false, reason: "signature_mismatch" };
  }
  const eq = timingSafeEqual(
    Buffer.from(expectedHmac, "utf8"),
    Buffer.from(hmacStr, "utf8"),
  );
  return eq ? { ok: true } : { ok: false, reason: "signature_mismatch" };
}
