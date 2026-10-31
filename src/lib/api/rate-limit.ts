import "server-only";

import type { ApiKeyScope } from "@/types/api";

/**
 * In-memory sliding-window rate limit for the public API, per key and per mode
 * (so test bursts can't lock out live).
 *
 *                  per-minute   per-hour
 *   admin               60        1,000
 *   forms-ingest       300        none (browser traffic runs hot; the minute
 *                                 cap is the one that matters)
 *
 * Per-instance counters, so limits are generous enough that multi-instance
 * under-counting doesn't hurt anyone. If that ever flaps, swap in Upstash
 * Ratelimit behind the same `checkAndCount` interface.
 *
 * Only counts requests after auth succeeds, so unauthenticated requests naming a
 * key prefix can't exhaust that key's budget.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const minuteBuckets = new Map<string, Bucket>();
const hourBuckets = new Map<string, Bucket>();
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

interface Limits {
  perMinute: number;
  perHour: number | null;
}

const LIMITS_BY_SCOPE: Record<ApiKeyScope, Limits> = {
  admin: { perMinute: 60, perHour: 1000 },
  "forms-ingest": { perMinute: 300, perHour: null },
};

export interface RateLimitResult {
  ok: boolean;
  /** Seconds until the most restrictive bucket resets. 0 when ok. */
  retryAfterSec: number;
  window: "minute" | "hour" | null;
  /** For X-RateLimit-Limit. */
  limit: number | null;
}

function check(
  bucketMap: Map<string, Bucket>,
  key: string,
  windowMs: number,
  limit: number,
  now: number,
): { ok: true } | { ok: false; retryAfterSec: number } {
  let b = bucketMap.get(key);
  if (!b || now >= b.resetAt) {
    b = { count: 0, resetAt: now + windowMs };
  }
  if (b.count >= limit) {
    bucketMap.set(key, b);
    return {
      ok: false,
      retryAfterSec: Math.max(1, Math.ceil((b.resetAt - now) / 1000)),
    };
  }
  b.count += 1;
  bucketMap.set(key, b);
  return { ok: true };
}

/**
 * Check and count against both windows. If one window accepts and the other
 * rejects, the accepted one stays incremented; harmless, since the caller is
 * still within that budget.
 */
export function checkAndCount(opts: {
  keyId: string;
  mode: "live" | "test";
  scope: ApiKeyScope;
}): RateLimitResult {
  const limits = LIMITS_BY_SCOPE[opts.scope];
  const now = Date.now();
  const bucketKey = `${opts.keyId}_${opts.mode}`;

  const minute = check(
    minuteBuckets,
    `${bucketKey}_m`,
    MINUTE_MS,
    limits.perMinute,
    now,
  );
  if (!minute.ok) {
    return {
      ok: false,
      retryAfterSec: minute.retryAfterSec,
      window: "minute",
      limit: limits.perMinute,
    };
  }

  // Some scopes have no hourly cap.
  if (limits.perHour !== null) {
    const hour = check(
      hourBuckets,
      `${bucketKey}_h`,
      HOUR_MS,
      limits.perHour,
      now,
    );
    if (!hour.ok) {
      return {
        ok: false,
        retryAfterSec: hour.retryAfterSec,
        window: "hour",
        limit: limits.perHour,
      };
    }
  }

  // Bound memory on long-lived instances.
  if (minuteBuckets.size > 10_000) prune(minuteBuckets, now);
  if (hourBuckets.size > 10_000) prune(hourBuckets, now);

  return { ok: true, retryAfterSec: 0, window: null, limit: null };
}

function prune(bucketMap: Map<string, Bucket>, now: number): void {
  for (const [k, b] of bucketMap) {
    if (now >= b.resetAt) bucketMap.delete(k);
  }
}

/** Read-only minute-bucket state for response headers. Call after checkAndCount succeeds. */
export function snapshotRemaining(opts: {
  keyId: string;
  mode: "live" | "test";
  scope: ApiKeyScope;
}): { limit: number; remaining: number; resetSec: number } {
  const limits = LIMITS_BY_SCOPE[opts.scope];
  const now = Date.now();
  const b = minuteBuckets.get(`${opts.keyId}_${opts.mode}_m`);
  if (!b || now >= b.resetAt) {
    return {
      limit: limits.perMinute,
      remaining: limits.perMinute - 1,
      resetSec: Math.ceil(MINUTE_MS / 1000),
    };
  }
  return {
    limit: limits.perMinute,
    remaining: Math.max(0, limits.perMinute - b.count),
    resetSec: Math.max(1, Math.ceil((b.resetAt - now) / 1000)),
  };
}
