import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { eventOccupiesSlot, eventStatus, isImportedEvent } from "@/types/events";
import type { CalendarEvent } from "@/types/events";
import type { BookingHost } from "@/types/booking";
import type { SubAccountMemberDoc } from "@/types/tenancy";

/**
 * Team mode (round-robin) helpers. A page with a non-empty `hosts` list offers
 * the union of the hosts' free time and assigns each booking to the
 * least-loaded free host.
 */

/**
 * Filter a requested host list to active members, re-snapshotting `name` from
 * the member doc (never trust the client's), keeping order and per-host
 * `workingHours`. Called from the booking-page POST/PATCH routes.
 */
export async function resolveBookingHosts(
  subAccountId: string,
  requested: BookingHost[] | undefined | null,
): Promise<BookingHost[]> {
  const reqList = requested ?? [];
  if (reqList.length === 0) return [];

  const snap = await getAdminDb()
    .collection(`subAccounts/${subAccountId}/subAccountMembers`)
    .get();
  const activeByUid = new Map<string, SubAccountMemberDoc>();
  for (const d of snap.docs) {
    const m = d.data() as SubAccountMemberDoc;
    const uid = m.uid ?? d.id;
    if (m.status === "active") activeByUid.set(uid, m);
  }

  const out: BookingHost[] = [];
  const seen = new Set<string>();
  for (const h of reqList) {
    if (seen.has(h.uid)) continue;
    const m = activeByUid.get(h.uid);
    if (!m) continue; // no longer an active member
    seen.add(h.uid);
    const name = (m.displayName || m.email || h.name || "Host").slice(0, 120);
    const resolved: BookingHost = { uid: h.uid, name };
    // Already shape-validated. Omitted when empty so the host inherits page hours.
    if (h.workingHours && h.workingHours.length > 0) {
      resolved.workingHours = h.workingHours;
    }
    out.push(resolved);
  }
  return out;
}

/** Assigned host's name + email for the notification. null means skip it (never fatal). */
export async function loadHostNotifyContact(
  subAccountId: string,
  uid: string,
): Promise<{ name: string; email: string } | null> {
  try {
    const snap = await getAdminDb()
      .doc(`subAccounts/${subAccountId}/subAccountMembers/${uid}`)
      .get();
    if (!snap.exists) return null;
    const m = snap.data() as SubAccountMemberDoc;
    const email = (m.email ?? "").trim();
    if (!email) return null;
    return {
      name: (m.displayName || m.email || "Host").slice(0, 120),
      email,
    };
  } catch (err) {
    console.warn(`[booking/hosts] notify contact lookup failed uid=${uid}`, err);
    return null;
  }
}

/**
 * Upcoming bookings per host, for the least-loaded pick. Runs before the book
 * transaction; slightly stale is fine. Needs the
 * `events(subAccountId, assignedToUid, startAt)` composite index.
 */
export async function loadHostUpcomingCounts(
  subAccountId: string,
  hostUids: string[],
  now: Date,
): Promise<Map<string, number>> {
  const db = getAdminDb();
  const counts = new Map<string, number>();
  await Promise.all(
    hostUids.map(async (uid) => {
      try {
        const snap = await db
          .collection("events")
          .where("subAccountId", "==", subAccountId)
          .where("assignedToUid", "==", uid)
          .where("startAt", ">=", now)
          .get();
        let n = 0;
        for (const d of snap.docs) {
          const e = d.data() as CalendarEvent;
          // Imported Google events: free/busy already covers them, and they never
          // count as bookings or leave the CRM.
          if (isImportedEvent(e)) continue;
          if (eventOccupiesSlot(eventStatus(e))) n++;
        }
        counts.set(uid, n);
      } catch (err) {
        // Probably the index isn't deployed. Count as zero so assignment still works, just unbalanced.
        console.warn(`[booking/hosts] load count failed uid=${uid}`, err);
        counts.set(uid, 0);
      }
    }),
  );
  return counts;
}

/** Least-loaded of the hosts free at the slot; ties go to page order. null = slot full (409). */
export function pickLeastLoadedHost(
  freeHosts: BookingHost[],
  loadByHost: Map<string, number>,
): BookingHost | null {
  if (freeHosts.length === 0) return null;
  let best = freeHosts[0];
  let bestLoad = loadByHost.get(best.uid) ?? 0;
  for (let i = 1; i < freeHosts.length; i++) {
    const load = loadByHost.get(freeHosts[i].uid) ?? 0;
    if (load < bestLoad) {
      best = freeHosts[i];
      bestLoad = load;
    }
  }
  return best;
}
