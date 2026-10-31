import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Token for the per-sub-account calendar.ics feed:
 *
 *   base64url(HMAC-SHA256(AUTOMATIONS_TOKEN_SECRET, "calfeed:" + subAccountId))
 *
 * Deterministic so the URL pasted into Google Calendar stays stable. Rotating
 * the secret is how you kill a leaked URL. The `calfeed:` prefix keeps it
 * distinct from other tokens signed with the same secret.
 */

const DOMAIN_PREFIX = "calfeed:";
// Separate prefix so sub-account and per-host tokens can't stand in for each other.
const HOST_DOMAIN_PREFIX = "calfeedhost:";

function getSecret(): string {
  const s = process.env.AUTOMATIONS_TOKEN_SECRET;
  if (!s) {
    throw new Error(
      "AUTOMATIONS_TOKEN_SECRET is required to mint calendar-feed tokens.",
    );
  }
  return s;
}

function toBase64Url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function generateCalendarFeedToken(subAccountId: string): string {
  const mac = createHmac("sha256", getSecret())
    .update(`${DOMAIN_PREFIX}${subAccountId}`, "utf8")
    .digest();
  return toBase64Url(mac);
}

/** Constant-time. Length check first because timingSafeEqual throws on mismatch. */
export function verifyCalendarFeedToken(
  subAccountId: string,
  presented: string,
): boolean {
  if (!presented || typeof presented !== "string") return false;
  let expected: string;
  try {
    expected = generateCalendarFeedToken(subAccountId);
  } catch {
    return false;
  }
  if (expected.length !== presented.length) return false;
  return timingSafeEqual(
    Buffer.from(expected, "utf8"),
    Buffer.from(presented, "utf8"),
  );
}

/** URL the operator subscribes to from Google/Apple Calendar or Outlook. */
export function buildCalendarFeedUrl(subAccountId: string): string {
  const base =
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
  const token = generateCalendarFeedToken(subAccountId);
  return `${base}/api/sub-accounts/${subAccountId}/calendar.ics?t=${token}`;
}

/**
 * Per-host ("just my bookings") token, bound to both the sub-account and uid,
 * so swapping the `?host=` uid fails verification.
 */
export function generateHostCalendarFeedToken(
  subAccountId: string,
  uid: string,
): string {
  const mac = createHmac("sha256", getSecret())
    .update(`${HOST_DOMAIN_PREFIX}${subAccountId}:${uid}`, "utf8")
    .digest();
  return toBase64Url(mac);
}

/** Constant-time. False on any malformed input. */
export function verifyHostCalendarFeedToken(
  subAccountId: string,
  uid: string,
  presented: string,
): boolean {
  if (!presented || typeof presented !== "string") return false;
  if (!uid || typeof uid !== "string") return false;
  let expected: string;
  try {
    expected = generateHostCalendarFeedToken(subAccountId, uid);
  } catch {
    return false;
  }
  if (expected.length !== presented.length) return false;
  return timingSafeEqual(
    Buffer.from(expected, "utf8"),
    Buffer.from(presented, "utf8"),
  );
}

/** Only bookings assigned to `uid`. */
export function buildHostCalendarFeedUrl(
  subAccountId: string,
  uid: string,
): string {
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
  const token = generateHostCalendarFeedToken(subAccountId, uid);
  return `${base}/api/sub-accounts/${subAccountId}/calendar.ics?host=${encodeURIComponent(uid)}&t=${token}`;
}
