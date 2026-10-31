import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { queryFreeBusy } from "@/lib/google/calendar";
import type { BusyEventWithHost } from "@/lib/booking/availability";
import type { CalendarConnectionDoc } from "@/types/calendar-sync";

/**
 * Turns connected members' Google Calendar busy blocks into BusyEventWithHost
 * rows, the same shape as internal events, so the availability calculator
 * doesn't need to know about Google.
 *
 * Fails open: a Google outage, timeout or revoked token gives that member an
 * empty list (revocation handling lives in the calendar lib). Never throws.
 * A booking page must keep serving internal-only slots whatever Google does.
 *
 * Used by public availability, the book route's re-verify (fetched before the
 * transaction; no HTTP inside a retrying transaction), reschedule, and voice
 * booking.
 */

/**
 * 60s per-instance cache. The slot picker re-queries the same window on every
 * date flip, and this keeps us well inside Google's quota. Book-time windows
 * are slot-specific and mostly miss, which is what we want at commit.
 */
const CACHE_TTL_MS = 60_000;
const cache = new Map<
  string,
  { at: number; busy: Array<{ startAt: Date; endAt: Date }> }
>();

function cacheKey(saId: string, uid: string, from: Date, to: Date): string {
  return `${saId}:${uid}:${from.getTime()}:${to.getTime()}`;
}

function pruneCache(): void {
  if (cache.size <= 2000) return;
  const cutoff = Date.now() - CACHE_TTL_MS;
  for (const [k, v] of cache) {
    if (v.at < cutoff) cache.delete(k);
  }
  // Still too big after pruning stale rows: drop oldest insertions.
  while (cache.size > 2000) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * Busy intervals per connected member, tagged with `assignedToUid`.
 * `onlyUids` limits the Google calls to hosts that can affect the answer; omit
 * it to include every connected member.
 */
export async function fetchExternalBusy(
  subAccountId: string,
  window: { from: Date; to: Date },
  opts: { onlyUids?: string[] } = {},
): Promise<BusyEventWithHost[]> {
  try {
    const snap = await getAdminDb()
      .collection(`subAccounts/${subAccountId}/calendarConnections`)
      .where("status", "==", "connected")
      .get();
    if (snap.empty) return [];

    let uids = snap.docs.map((d) => (d.data() as CalendarConnectionDoc).uid);
    if (opts.onlyUids) {
      const allow = new Set(opts.onlyUids);
      uids = uids.filter((u) => allow.has(u));
    }
    if (uids.length === 0) return [];

    const perHost = await Promise.all(
      uids.map(async (uid): Promise<BusyEventWithHost[]> => {
        const key = cacheKey(subAccountId, uid, window.from, window.to);
        const hit = cache.get(key);
        if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
          return hit.busy.map((b) => ({ ...b, assignedToUid: uid }));
        }
        try {
          const busy = await queryFreeBusy(
            subAccountId,
            uid,
            window.from,
            window.to,
          );
          cache.set(key, { at: Date.now(), busy });
          pruneCache();
          return busy.map((b) => ({ ...b, assignedToUid: uid }));
        } catch (err) {
          // Fail open for this host. The lib already handled revocation.
          console.warn(
            `[booking/external-busy] freeBusy failed sa=${subAccountId} uid=${uid}`,
            err instanceof Error ? err.message : err,
          );
          return [];
        }
      }),
    );
    return perHost.flat();
  } catch (err) {
    // Even a failed connection listing must not break availability.
    console.warn(
      `[booking/external-busy] collector failed sa=${subAccountId}`,
      err,
    );
    return [];
  }
}
