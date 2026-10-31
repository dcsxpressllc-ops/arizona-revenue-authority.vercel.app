import "server-only";

/**
 * Spam guard for the public form submit endpoint (`/api/forms/[id]/submit`).
 * The endpoint has to be unauthenticated, and each accepted submission costs
 * the tenant: a Contact, maybe a Deal, webhooks, workflows, Speed-to-Lead
 * SMS/email.
 *
 * Three zero-config checks:
 *   1. Honeypot: off-screen input real users never see. Filled = bot.
 *   2. Time-to-submit under {@link MIN_ELAPSED_MS} = bot. Even autofill + click
 *      takes longer than that.
 *   3. Per-IP rate limit, for bots POSTing straight to the JSON endpoint. Two
 *      buckets catch both a burst on one form and a slow spray across many.
 *
 * Traps (1, 2) get a silent fake `{ ok: true }` so the bot can't tell it was
 * filtered. Rate limits return 429 + Retry-After, because a real visitor
 * behind shared NAT can hit them.
 *
 * Both client signals are optional; absent = pass. Older pasted snippets,
 * hand-written forms and direct JSON POSTs keep working (the docs promise a
 * bare `{ values }` body is accepted), with only the rate limit applying.
 *
 * Limiter is an in-memory LRU like the checkout and web-chat ones: resets on
 * cold start, per-instance on serverless. Fine for dampening abuse, and no
 * write per submission.
 */

/** Client-reported time-on-form below this = bot. */
export const MIN_ELAPSED_MS = 1_500;

/** Sent outside `values` so it can't collide with a field id or leak into merge tags / webhooks. */
export const HONEYPOT_BODY_KEY = "hp";
/** Client-measured time-on-form, ms. */
export const ELAPSED_BODY_KEY = "elapsedMs";

// Per (ip, form) catches a burst on one form; per ip catches a slow spray.
// Loose enough for an agency demoing a form a dozen times or a busy office NAT.
const PER_FORM_LIMIT = 12;
const PER_FORM_WINDOW_MS = 10 * 60 * 1000;
const PER_IP_LIMIT = 60;
const PER_IP_WINDOW_MS = 60 * 60 * 1000;
const MAX_TRACKED_KEYS = 10_000;

interface Bucket {
  count: number;
  windowStartedAt: number;
}

const perFormBuckets = new Map<string, Bucket>();
const perIpBuckets = new Map<string, Bucket>();

function evictIfNeeded(map: Map<string, Bucket>, windowMs: number, now: number) {
  if (map.size <= MAX_TRACKED_KEYS) return;
  const cutoff = now - windowMs;
  for (const [key, b] of map) {
    if (b.windowStartedAt < cutoff) map.delete(key);
  }
  if (map.size > MAX_TRACKED_KEYS) map.clear();
}

/** Seconds until reset when over the limit, else 0. */
function hit(
  map: Map<string, Bucket>,
  key: string,
  limit: number,
  windowMs: number,
  now: number,
): number {
  evictIfNeeded(map, windowMs, now);
  let bucket = map.get(key);
  if (!bucket || now - bucket.windowStartedAt > windowMs) {
    bucket = { count: 0, windowStartedAt: now };
  }
  if (bucket.count >= limit) {
    map.set(key, bucket);
    return Math.max(1, Math.ceil((bucket.windowStartedAt + windowMs - now) / 1000));
  }
  bucket.count += 1;
  map.set(key, bucket);
  return 0;
}

export type FormSpamVerdict =
  | { kind: "ok" }
  /** Bot trap tripped: answer with a silent fake success, create nothing. */
  | { kind: "trap"; reason: "honeypot" | "too_fast" }
  /** Too many submissions from this IP: answer 429 + Retry-After. */
  | { kind: "rate_limited"; retryAfterSec: number };

export function checkFormSpam(input: {
  ip: string | null;
  formId: string;
  honeypot: unknown;
  /** Time-on-form in ms, if sent. */
  elapsedMs: unknown;
}): FormSpamVerdict {
  // Traps first: free, and they don't spend rate-limit budget, so a bot can't
  // lock real visitors out of the shared bucket.
  if (typeof input.honeypot === "string" && input.honeypot.trim().length > 0) {
    return { kind: "trap", reason: "honeypot" };
  }
  if (
    typeof input.elapsedMs === "number" &&
    Number.isFinite(input.elapsedMs) &&
    input.elapsedMs >= 0 &&
    input.elapsedMs < MIN_ELAPSED_MS
  ) {
    return { kind: "trap", reason: "too_fast" };
  }

  // No proxy headers (local dev, odd hosts) still buckets under "unknown":
  // one shared bucket beats no limit.
  const ip = input.ip || "unknown";
  const now = Date.now();
  const perForm = hit(
    perFormBuckets,
    `${ip}:${input.formId}`,
    PER_FORM_LIMIT,
    PER_FORM_WINDOW_MS,
    now,
  );
  if (perForm > 0) return { kind: "rate_limited", retryAfterSec: perForm };
  const perIp = hit(perIpBuckets, ip, PER_IP_LIMIT, PER_IP_WINDOW_MS, now);
  if (perIp > 0) return { kind: "rate_limited", retryAfterSec: perIp };

  return { kind: "ok" };
}
