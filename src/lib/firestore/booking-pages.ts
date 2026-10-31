import {
  collection,
  doc,
  onSnapshot,
  query,
  where,
  type Unsubscribe,
} from "firebase/firestore";
import { getFirebaseDb } from "@/lib/firebase/client";
import type { BookingPage } from "@/types/booking";
import type { CalendarEvent } from "@/types/events";

/**
 * Client subscriptions for the booking pages list and editor. Writes go
 * through /api/sub-accounts/[id]/booking-pages/*; rules block client writes.
 * Filters on `subAccountId` despite the subcollection, same defensive pattern
 * as subscribeToTerritories.
 */
export function subscribeToBookingPages(
  subAccountId: string,
  callback: (pages: BookingPage[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  const q = query(
    collection(getFirebaseDb(), "subAccounts", subAccountId, "bookingPages"),
    where("subAccountId", "==", subAccountId),
  );
  return onSnapshot(
    q,
    (snap) => {
      const list = snap.docs.map(
        (d) => ({ id: d.id, ...(d.data() as Omit<BookingPage, "id">) }),
      );
      list.sort((a, b) => a.name.localeCompare(b.name));
      callback(list);
    },
    (err) => onError?.(err),
  );
}

/** Single page by slug, for the editor. */
export function subscribeToBookingPage(
  subAccountId: string,
  slug: string,
  callback: (page: BookingPage | null) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  return onSnapshot(
    doc(getFirebaseDb(), "subAccounts", subAccountId, "bookingPages", slug),
    (snap) => {
      if (!snap.exists()) {
        callback(null);
        return;
      }
      callback({ id: snap.id, ...(snap.data() as Omit<BookingPage, "id">) });
    },
    (err) => onError?.(err),
  );
}

/**
 * Events from one booking page, newest startAt first, via the
 * events(subAccountId, bookingPageSlug, startAt DESC) index. Territory
 * filtering happens client-side so the index doesn't need a fourth field;
 * bookings per page are few.
 */
export function subscribeToBookingPageEvents(
  subAccountId: string,
  slug: string,
  callback: (events: CalendarEvent[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  const q = query(
    collection(getFirebaseDb(), "events"),
    where("subAccountId", "==", subAccountId),
    where("bookingPageSlug", "==", slug),
  );
  return onSnapshot(
    q,
    (snap) => {
      const events = snap.docs.map(
        (d) => ({ id: d.id, ...(d.data() as Omit<CalendarEvent, "id">) }),
      );
      events.sort((a, b) => toMillis(b.startAt) - toMillis(a.startAt));
      callback(events);
    },
    (err) => onError?.(err),
  );
}

function toMillis(v: unknown): number {
  if (!v) return 0;
  if (v instanceof Date) return v.getTime();
  const maybe = v as { toDate?: () => Date; seconds?: number };
  if (typeof maybe.toDate === "function") return maybe.toDate().getTime();
  if (typeof maybe.seconds === "number") return maybe.seconds * 1000;
  return 0;
}
