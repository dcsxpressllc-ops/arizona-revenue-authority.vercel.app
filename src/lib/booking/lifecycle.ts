import "server-only";

import { FieldValue, type Timestamp } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { fireWorkflowTrigger } from "@/lib/workflows/engine";
import { publishCallback, qstashIsConfigured } from "@/lib/automations/qstash";
import { emitWebhookEvent } from "@/lib/api/webhooks/dispatch";
import type { ActivityType } from "@/types/contacts";
import type { WebhookEventType } from "@/types/webhooks";
import type { AutomationTriggerType } from "@/types";
import type { CalendarEvent } from "@/types/events";
import type { BookingPage } from "@/types/booking";

/**
 * Side effects of booking lifecycle changes (timeline row, automation trigger,
 * reminders) so the book/cancel/reschedule/mark-paid routes stay small.
 *
 * Everything here swallows errors: the primary write has already committed and
 * a timeline failure must not break the public booking page.
 */

type BookingLifecycleEvent =
  | "booking_page_booked"
  | "booking_payment_received"
  | "booking_cancelled"
  | "booking_rescheduled"
  | "booking_no_show"
  | "booking_completed";

/** Tenancy comes from the parent contact. createdBy = "booking" marks it as system-generated. */
export async function recordBookingActivity(
  event: Pick<CalendarEvent, "id" | "title" | "contactId" | "bookingPageSlug">,
  type: BookingLifecycleEvent,
  opts: {
    extra?: string | null;
    paymentAmount?: number;
    paymentCurrency?: string;
  } = {},
): Promise<void> {
  if (!event.contactId) return;
  try {
    const content = defaultContent(event.title || "Meeting", type, opts.extra);
    await getAdminDb()
      .collection("contacts")
      .doc(event.contactId)
      .collection("activities")
      .add({
        type: type satisfies ActivityType,
        content,
        createdBy: "booking",
        meta: {
          eventId: event.id,
          bookingPageSlug: event.bookingPageSlug ?? undefined,
          paymentAmount: opts.paymentAmount,
          paymentCurrency: opts.paymentCurrency,
        },
        createdAt: FieldValue.serverTimestamp(),
      });
  } catch (err) {
    console.warn(`[booking/lifecycle] activity write failed for ${type}`, err);
  }
}

function defaultContent(
  title: string,
  type: BookingLifecycleEvent,
  extra: string | null | undefined,
): string {
  const suffix = extra ? ` — ${extra}` : "";
  switch (type) {
    case "booking_page_booked":
      return `Meeting booked: "${title}"${suffix}.`;
    case "booking_payment_received":
      return `Booking payment received for "${title}"${suffix}.`;
    case "booking_cancelled":
      return `Meeting cancelled: "${title}"${suffix}.`;
    case "booking_rescheduled":
      return `Meeting rescheduled: "${title}"${suffix}.`;
    case "booking_no_show":
      return `No-show on "${title}"${suffix}.`;
    case "booking_completed":
      return `Meeting completed: "${title}"${suffix}.`;
  }
}

/** Fire the workflow trigger for a booking event. Safe from any path. */
export async function fireBookingTrigger(
  event: Pick<CalendarEvent, "agencyId" | "subAccountId" | "contactId">,
  trigger: Extract<AutomationTriggerType, `event_${string}`>,
): Promise<void> {
  if (!event.contactId) return;
  const type =
    trigger === "event_booked"
      ? ("booking.created" as const)
      : trigger === "event_cancelled"
        ? ("booking.cancelled" as const)
        : trigger === "event_rescheduled"
          ? ("booking.rescheduled" as const)
          : null;
  if (type) {
    void fireWorkflowTrigger({
      agencyId: event.agencyId,
      subAccountId: event.subAccountId,
      type,
      contactId: event.contactId,
    });
  }
}

const BOOKING_WEBHOOK_MAP: Partial<
  Record<BookingLifecycleEvent, WebhookEventType>
> = {
  booking_page_booked: "booking.created",
  booking_cancelled: "booking.cancelled",
};

function tsToIsoOrNull(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  const maybe = v as { toDate?: () => Date; seconds?: number };
  if (typeof maybe.toDate === "function") return maybe.toDate().toISOString();
  if (typeof maybe.seconds === "number") {
    return new Date(maybe.seconds * 1000).toISOString();
  }
  return null;
}

/**
 * No-op for events with no webhook type (reschedule, no-show, completed,
 * payment-received). Re-reads the doc so the payload has post-write state.
 * Safe to `void`. Bookings are always live; there's no test mode here.
 */
export async function emitBookingWebhook(opts: {
  eventId: string;
  agencyId: string;
  subAccountId: string;
  type: BookingLifecycleEvent;
  cancelReason?: string | null;
}): Promise<void> {
  const webhookType = BOOKING_WEBHOOK_MAP[opts.type];
  if (!webhookType) return;
  try {
    const snap = await getAdminDb().doc(`events/${opts.eventId}`).get();
    const data = snap.exists ? snap.data()! : {};
    const cancelled = webhookType === "booking.cancelled";
    // Include the page timezone so push notifications can show start_at in the
    // booking's zone rather than the server's (UTC). Omitted if the page is gone.
    const slug = (data.bookingPageSlug as string | null) ?? null;
    let timezone: string | null = null;
    if (slug) {
      try {
        const pageSnap = await getAdminDb()
          .doc(`subAccounts/${opts.subAccountId}/bookingPages/${slug}`)
          .get();
        timezone = (pageSnap.data()?.timezone as string | undefined) ?? null;
      } catch {
        timezone = null;
      }
    }
    await emitWebhookEvent({
      subAccountId: opts.subAccountId,
      agencyId: opts.agencyId,
      mode: "live",
      type: webhookType,
      payload: {
        booking: {
          id: opts.eventId,
          object: "booking",
          slug,
          contact_id: (data.contactId as string | null) ?? null,
          title: (data.title as string | null) ?? null,
          start_at: tsToIsoOrNull(data.startAt),
          end_at: tsToIsoOrNull(data.endAt),
          timezone,
          status: (data.status as string | null) ?? "scheduled",
          created_at: tsToIsoOrNull(data.createdAt),
          cancelled_at: cancelled
            ? (tsToIsoOrNull(data.cancelledAt) ?? new Date().toISOString())
            : null,
          cancel_reason: cancelled
            ? (opts.cancelReason ?? (data.cancelReason as string | null) ?? null)
            : null,
        },
      },
    });
  } catch (err) {
    console.warn(`[booking/lifecycle] webhook emit failed for ${opts.type}`, err);
  }
}

/**
 * Schedule one QStash callback to /api/events/reminder/step per configured
 * offset. Offsets already in the past are skipped. Without QStash we log and
 * skip; the booking still succeeds. Dedup ids include event id + offset.
 */
export async function scheduleEventReminders(input: {
  eventId: string;
  startAt: Date;
  reminderOffsetsMinutes: number[];
  /**
   * Raw token, carried in the QStash payload so the receiver can build the
   * reschedule/cancel URL without re-minting (which would rotate the stored hash).
   * Firestore only has the hash.
   */
  rawToken: string;
  /** True for `awaiting_payment`; scheduling waits until marked paid. */
  pendingPayment: boolean;
  /** Reschedules pass a fresh nonce so new callbacks don't collapse into the old slot's. */
  scheduleNonce?: string;
  /**
   * The page's channel toggles at scheduling time. The step reads the live
   * page first; this snapshot only decides what to send if the page is gone.
   */
  page?: Pick<
    BookingPage,
    "remindersEnabled" | "smsRemindersEnabled" | "name" | "timezone"
  > | null;
}): Promise<void> {
  if (input.pendingPayment) return;
  if (input.reminderOffsetsMinutes.length === 0) return;
  if (!qstashIsConfigured()) {
    console.warn(
      "[booking/lifecycle] QStash not configured — reminders won't fire for event " +
        input.eventId,
    );
    return;
  }
  const now = Date.now();
  for (const offsetMin of input.reminderOffsetsMinutes) {
    const fireAt = input.startAt.getTime() - offsetMin * 60_000;
    const delaySeconds = Math.floor((fireAt - now) / 1000);
    // Offset already passed (e.g. event in 30 min, offset T-1h).
    if (delaySeconds < 30) continue;
    const nonceSuffix = input.scheduleNonce ? `_${input.scheduleNonce}` : "";
    try {
      await publishCallback({
        pathname: "/api/events/reminder/step",
        body: {
          eventId: input.eventId,
          offsetMinutes: offsetMin,
          token: input.rawToken,
          ...(input.page
            ? {
                channels: {
                  email: input.page.remindersEnabled !== false,
                  sms: input.page.smsRemindersEnabled === true,
                  pageName: input.page.name,
                  timezone: input.page.timezone,
                },
              }
            : {}),
        },
        delaySeconds,
        deduplicationId: `evt_reminder_${input.eventId}_${offsetMin}${nonceSuffix}`,
      });
    } catch (err) {
      console.warn(
        `[booking/lifecycle] reminder schedule failed (offset ${offsetMin})`,
        err,
      );
    }
  }
}

/** At `paymentHoldExpiresAt`, cancel the booking if still unpaid. Dedup by event id. */
export async function schedulePaymentAutoExpire(input: {
  eventId: string;
  expiresAt: Date;
}): Promise<void> {
  if (!qstashIsConfigured()) {
    console.warn(
      "[booking/lifecycle] QStash not configured — payment hold won't auto-expire for event " +
        input.eventId,
    );
    return;
  }
  const delaySeconds = Math.max(
    30,
    Math.floor((input.expiresAt.getTime() - Date.now()) / 1000),
  );
  try {
    await publishCallback({
      pathname: "/api/events/payment/expire-step",
      body: { eventId: input.eventId },
      delaySeconds,
      deduplicationId: `evt_pay_expire_${input.eventId}`,
    });
  } catch (err) {
    console.warn("[booking/lifecycle] auto-expire schedule failed", err);
  }
}

export function timestampToDate(
  ts: Timestamp | { toDate?: () => Date } | Date | null | undefined,
): Date | null {
  if (!ts) return null;
  if (ts instanceof Date) return ts;
  const maybe = ts as { toDate?: () => Date };
  if (typeof maybe.toDate === "function") return maybe.toDate();
  return null;
}

// Google Calendar push (outbound half of two-way sync). Best-effort: a Google
// failure logs and moves on, and the .ics feed is the fallback. We write
// through one member's connection: the assigned host in team mode, otherwise
// the member who created the booking page.

/** Whose Google Calendar a booking lands on. null = nobody (no push). */
export function bookingCalendarOwnerUid(
  page: Pick<BookingPage, "hosts" | "createdByUid">,
  assignedToUid: string | null,
): string | null {
  if (assignedToUid) return assignedToUid;
  // Team pages always assign; an unassigned team event has no owner.
  if (page.hosts && page.hosts.length > 0) return null;
  return page.createdByUid || null;
}

/**
 * Insert into the owner's Google Calendar and store the Google event id so
 * reschedule/cancel can find it. With `addMeet`, the new Meet link is also
 * stored as the event's meetingUrl and returned. Silent no-op without a
 * connection; never throws.
 */
export async function pushBookingToGoogle(input: {
  eventId: string;
  subAccountId: string;
  calendarOwnerUid: string | null;
  title: string;
  description: string;
  location?: string;
  startAt: Date;
  endAt: Date;
  addMeet?: boolean;
  /** Join link added to the Google description when no Meet room was made. */
  fallbackJoinUrl?: string | null;
}): Promise<{ meetUrl: string | null }> {
  if (!input.calendarOwnerUid) return { meetUrl: null };
  try {
    // A member who left keeps their Google connection doc; customer details
    // must not keep flowing into their personal calendar.
    const {
      insertCalendarEvent,
      patchCalendarEvent,
      GoogleCalendarError,
      isActiveCalendarOwner,
    } = await import("@/lib/google/calendar");
    if (!(await isActiveCalendarOwner(input.subAccountId, input.calendarOwnerUid))) {
      return { meetUrl: null };
    }
    try {
      const inserted = await insertCalendarEvent(
        input.subAccountId,
        input.calendarOwnerUid,
        {
          leadstackEventId: input.eventId,
          summary: input.title,
          description: input.description,
          location: input.location,
          startAt: input.startAt,
          endAt: input.endAt,
          addMeet: input.addMeet,
        },
      );
      await getAdminDb()
        .collection("events")
        .doc(input.eventId)
        .update({
          googleCalendarEventId: inserted.id,
          googleCalendarOwnerUid: input.calendarOwnerUid,
          ...(inserted.meetUrl ? { meetingUrl: inserted.meetUrl } : {}),
        });
      // No Meet room (Meet disabled, or still pending): the attendee was sent
      // the fixed link, so the host's copy should carry it too.
      if (input.addMeet && !inserted.meetUrl && input.fallbackJoinUrl) {
        await patchCalendarEvent(
          input.subAccountId,
          input.calendarOwnerUid,
          inserted.id,
          input.eventId,
          {
            startAt: input.startAt,
            endAt: input.endAt,
            description: `${input.description}\nJoin: ${input.fallbackJoinUrl}`,
          },
        ).catch(() => {});
      }
      return { meetUrl: inserted.meetUrl };
    } catch (err) {
      if (err instanceof GoogleCalendarError && err.code === "not_connected") {
        return { meetUrl: null }; // owner hasn't connected; the common case
      }
      throw err;
    }
  } catch (err) {
    console.warn(
      `[booking/lifecycle] google push failed event=${input.eventId}`,
      err instanceof Error ? err.message : err,
    );
    return { meetUrl: null };
  }
}

/** Google description for a dashboard-created event. */
export function manualEventGoogleDescription(input: {
  notes?: string | null;
  meetingUrl?: string | null;
}): string {
  return [
    input.notes?.trim() || "",
    input.meetingUrl ? `Join: ${input.meetingUrl}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * After a dashboard edit: patch the Google copy, or for a manual event with no
 * copy yet (created before its owner connected), insert one into the
 * creator's calendar. Booking events keep their booking description. Never throws.
 */
export async function syncEventEditToGoogle(
  event: Pick<
    CalendarEvent,
    | "id"
    | "subAccountId"
    | "title"
    | "notes"
    | "location"
    | "meetingUrl"
    | "source"
    | "createdByUid"
    | "googleCalendarEventId"
    | "googleCalendarOwnerUid"
    | "createdAt"
  >,
  startAt: Date,
  endAt: Date,
): Promise<void> {
  // Imported events are never written back to Google.
  if (event.source === "google") return;
  const isManual = (event.source ?? "manual") === "manual";
  if (!event.googleCalendarEventId || !event.googleCalendarOwnerUid) {
    if (!isManual) return;
    // The create-time push may still be in flight, and inserting now could
    // make a second copy. A stale first copy is the lesser problem.
    const createdAt = timestampToDate(
      event.createdAt as { toDate?: () => Date } | null,
    );
    if (createdAt && Date.now() - createdAt.getTime() < 60_000) return;
    await pushBookingToGoogle({
      eventId: event.id,
      subAccountId: event.subAccountId,
      calendarOwnerUid: event.createdByUid || null,
      title: event.title,
      description: manualEventGoogleDescription(event),
      location: event.location || undefined,
      startAt,
      endAt,
    });
    return;
  }
  try {
    const { patchCalendarEvent } = await import("@/lib/google/calendar");
    await patchCalendarEvent(
      event.subAccountId,
      event.googleCalendarOwnerUid,
      event.googleCalendarEventId,
      event.id,
      {
        startAt,
        endAt,
        summary: event.title,
        ...(isManual
          ? {
              description: manualEventGoogleDescription(event),
              location: event.location ?? "",
            }
          : {}),
      },
    );
  } catch (err) {
    console.warn(
      `[booking/lifecycle] google edit sync failed event=${event.id}`,
      err instanceof Error ? err.message : err,
    );
  }
}

/** Reschedule never changes the host (only times + token), so this always patches the original calendar. */
export async function moveGoogleBookingCopy(
  event: Pick<
    CalendarEvent,
    "id" | "subAccountId" | "googleCalendarEventId" | "googleCalendarOwnerUid"
  >,
  newStart: Date,
  newEnd: Date,
): Promise<void> {
  if (!event.googleCalendarEventId || !event.googleCalendarOwnerUid) return;
  try {
    const { patchCalendarEvent } = await import("@/lib/google/calendar");
    await patchCalendarEvent(
      event.subAccountId,
      event.googleCalendarOwnerUid,
      event.googleCalendarEventId,
      event.id,
      { startAt: newStart, endAt: newEnd },
    );
  } catch (err) {
    console.warn(
      `[booking/lifecycle] google move failed event=${event.id}`,
      err instanceof Error ? err.message : err,
    );
  }
}

/** 404/410 from Google count as success; the host already deleted it. */
export async function deleteGoogleBookingCopy(
  event: Pick<
    CalendarEvent,
    "id" | "subAccountId" | "googleCalendarEventId" | "googleCalendarOwnerUid"
  >,
): Promise<void> {
  if (!event.googleCalendarEventId || !event.googleCalendarOwnerUid) return;
  try {
    const { deleteCalendarEvent } = await import("@/lib/google/calendar");
    await deleteCalendarEvent(
      event.subAccountId,
      event.googleCalendarOwnerUid,
      event.googleCalendarEventId,
      event.id,
    );
    // Clear the link so a repeat cancel doesn't call Google again.
    await getAdminDb().collection("events").doc(event.id).update({
      googleCalendarEventId: null,
      googleCalendarOwnerUid: null,
    });
  } catch (err) {
    console.warn(
      `[booking/lifecycle] google delete failed event=${event.id}`,
      err instanceof Error ? err.message : err,
    );
  }
}
