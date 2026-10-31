import "server-only";

/**
 * Per-IP limit for the public checkout session endpoint. It has to be
 * unauthenticated, and each call creates a Contact, a pending Order and a
 * Stripe session, so unbounded it's an easy way to junk up a tenant's CRM.
 * Nothing is charged without Stripe's payment page; this is anti-noise, not
 * anti-fraud.
 *
 * In-memory like the web-chat limiter. Resets on cold start, which is fine for
 * a dampener and saves a write per page view.
 */

const PER_IP_LIMIT = 15;
const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_TRACKED_IPS = 5_000;

interface Bucket {
  count: number;
  windowStartedAt: number;
}

const buckets = new Map<string, Bucket>();

export interface CheckoutRateLimitResult {
  ok: boolean;
  retryAfterSec: number;
}

export function checkCheckoutRateLimit(ip: string): CheckoutRateLimitResult {
  const now = Date.now();

  // Drop the oldest half instead of tracking true LRU.
  if (buckets.size > MAX_TRACKED_IPS) {
    const cutoff = now - WINDOW_MS;
    for (const [key, b] of buckets) {
      if (b.windowStartedAt < cutoff) buckets.delete(key);
    }
    if (buckets.size > MAX_TRACKED_IPS) buckets.clear();
  }

  let bucket = buckets.get(ip);
  if (!bucket || now - bucket.windowStartedAt > WINDOW_MS) {
    bucket = { count: 0, windowStartedAt: now };
  }

  if (bucket.count >= PER_IP_LIMIT) {
    buckets.set(ip, bucket);
    return {
      ok: false,
      retryAfterSec: Math.max(
        1,
        Math.ceil((bucket.windowStartedAt + WINDOW_MS - now) / 1000),
      ),
    };
  }

  bucket.count += 1;
  buckets.set(ip, bucket);
  return { ok: true, retryAfterSec: 0 };
}

/** From the proxy headers Vercel/Railway set. Best-effort. */
export function clientIpFrom(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}
