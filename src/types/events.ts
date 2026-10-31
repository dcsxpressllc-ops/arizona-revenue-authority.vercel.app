import type { Timestamp, FieldValue } from "firebase/firestore";
import type { CalendarImportMode } from "@/types/calendar-sync";

/**
 * Read via `eventStatus()`; older docs without the field mean "scheduled".
 * awaiting_payment: booking-page deposit hold. Slot is busy, no reminders.
 * scheduled fires reminders. completed, cancelled and no_show free the slot.
 */
export type EventStatus =
  | "scheduled"
  | "awaiting_payment"
  | "completed"
  | "cancelled"
  | "no_show";

/**
 * Read via `eventSource()`; missing = "manual". Only booking-page events fire
 * `event_booked`. "google" = imported from a member's Google Calendar:
 * read-only, and kept out of availability, the .ics feed, the API and search.
 */
export type EventSource = "manual" | "booking_page" | "google";

export interface CalendarEvent {
  id: string;
  title: string;
  startAt: Timestamp | FieldValue | null;
  endAt: Timestamp | FieldValue | null;
  contactId: string | null;
  location: string;
  notes: string;
  agencyId: string;
  subAccountId: string;
  createdByUid: string;
  /**
   * Inherited from the linked contact. null = standalone event (admin-only
   * triage when scoping is on). Ignored unless `territoryScopingEnabled`.
   */
  territoryId?: string | null;
  /** Use `eventStatus()`, never read directly. */
  status?: EventStatus;
  /** Use `eventSource()`, never read directly. */
  source?: EventSource;
  /** Set only when `source === "booking_page"`. */
  bookingPageSlug?: string | null;
  /**
   * Snapshot of the page's `meetingUrl` at booking time, so later page edits
   * don't change it. null = no video link.
   */
  meetingUrl?: string | null;
  /**
   * SHA-256 of the latest public /e/[token] token (raw token never stored).
   * Rotated on every reschedule so old links die.
   */
  publicTokenHash?: string | null;
  /**
   * The copy pushed to the host's Google Calendar, and whose connection wrote
   * it, so reschedule/cancel can move or delete it. Null = never pushed.
   */
  googleCalendarEventId?: string | null;
  googleCalendarOwnerUid?: string | null;
  /** SEQUENCE of the last updated invite emailed; calendar apps ignore one that doesn't go up. */
  icsSequence?: number;
  paymentRequired?: boolean;
  paymentAmount?: number | null;
  paymentCurrency?: string | null;
  /** Stateless PayPal.me URL minted at booking. */
  paymentLinkUrl?: string | null;
  /** Set when the operator moves `awaiting_payment` -> `scheduled`. */
  paidAt?: Timestamp | FieldValue | null;
  paidByUid?: string | null;
  /** Unpaid holds auto-cancel at this time (QStash callback). */
  paymentHoldExpiresAt?: Timestamp | FieldValue | null;
  /** Team-mode (round-robin) host. Null for single-schedule and manual events. */
  assignedToUid?: string | null;
  /** Snapshot at book time so the calendar and ICS feed skip a member lookup. */
  assignedToName?: string | null;
  cancelledAt?: Timestamp | FieldValue | null;
  /** True when cancelled via /e/[token]; falsy when the operator did it. */
  cancelledByVisitor?: boolean | null;
  /** Free text or "rescheduled" | "payment_expired" | "operator". */
  cancelReason?: string | null;
  /** Imported events only: date-only Google event, shown as all day. */
  allDay?: boolean;
  /** Imported all-day events: YYYY-MM-DD, end exclusive. Placed by date, not by instant. */
  allDayStart?: string | null;
  allDayEnd?: string | null;
  /**
   * Imported events only. Deliberately separate from googleCalendarEventId /
   * googleCalendarOwnerUid, which the booking push/move/delete code acts on.
   */
  importOwnerUid?: string | null;
  importOwnerName?: string | null;
  importedGoogleEventId?: string | null;
  /** Imported events only: the detail level it was imported at. */
  importMode?: CalendarImportMode;
  /** Imported events only: Google's etag, so unchanged events aren't rewritten. */
  googleEtag?: string | null;
  createdAt: Timestamp | FieldValue | null;
  updatedAt: Timestamp | FieldValue | null;
}

export type EventFormData = {
  title: string;
  startAt: Date;
  endAt: Date;
  contactId: string | null;
  location: string;
  notes: string;
  /** Zoom/Meet/etc. null = no link or in person. */
  meetingUrl?: string | null;
};

export function eventStatus(
  e: Pick<CalendarEvent, "status"> | { status?: EventStatus },
): EventStatus {
  return e.status ?? "scheduled";
}

/** Imported from Google: read-only in the CRM and excluded from bookings, feeds and the API. */
export function isImportedEvent(e: { source?: EventSource } | null | undefined): boolean {
  return e?.source === "google";
}

export function eventSource(
  e: Pick<CalendarEvent, "source"> | { source?: EventSource },
): EventSource {
  return e.source ?? "manual";
}

/** Shared by the availability calculator and UI badges so they agree. */
export function eventOccupiesSlot(status: EventStatus): boolean {
  return status === "scheduled" || status === "awaiting_payment";
}
