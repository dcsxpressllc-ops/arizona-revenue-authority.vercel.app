import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { emailIsConfigured, sendEmail, tenantFrom } from "@/lib/comms/resend";
import {
  computeRescheduleAvailability,
  isSlotAvailable,
  type BusyEventWithHost,
  type SlotCandidate,
} from "@/lib/booking/availability";
import { buildEventPublicUrl, issueEventToken } from "@/lib/booking/event-token";
import { fetchExternalBusy } from "@/lib/booking/external-busy";
import { generateIcs } from "@/lib/booking/ics";
import { icsDomain } from "@/lib/booking/ics-attachment";
import {
  deleteGoogleBookingCopy,
  emitBookingWebhook,
  fireBookingTrigger,
  moveGoogleBookingCopy,
  recordBookingActivity,
  scheduleEventReminders,
} from "@/lib/booking/lifecycle";
import {
  renderBookingCancelledEmail,
  renderBookingConfirmationEmail,
} from "@/lib/booking/email";
import { eventStatus, isImportedEvent } from "@/types/events";
import type { BookingPage } from "@/types/booking";
import type { CalendarEvent } from "@/types/events";
import type { Contact } from "@/types/contacts";
import type { SubAccountDoc } from "@/types/tenancy";
import { runAfterResponse } from "@/lib/server/after-response";

/**
 * Attendee-side cancel and reschedule of a booking-page booking. Used by the
 * public /e/[token] routes (the token is the credential) and by the AI agent
 * (the conversation's contact owns the booking). The caller's `guard` runs
 * inside the transaction against the live event and decides who may act.
 */

/** Return false to refuse the change (reported as `invalid`). */
export type BookingChangeGuard = (event: CalendarEvent) => boolean;

export type CancelBookingResult =
  | { ok: true; event: CalendarEvent; alreadyCancelled: boolean }
  | { ok: false; code: "invalid" }
  | { ok: false; code: "bad_state"; message: string }
  | { ok: false; code: "error" };

class GuardRefused extends Error {}
class BadState extends Error {
  constructor(public readonly message: string) {
    super(message);
  }
}
class SlotConflict extends Error {}

export async function cancelBooking(input: {
  eventId: string;
  guard: BookingChangeGuard;
  /** Appended to the activity row and webhook, e.g. "by attendee". */
  note: string;
}): Promise<CancelBookingResult> {
  const db = getAdminDb();
  const ref = db.collection("events").doc(input.eventId);

  let result: { event: CalendarEvent; alreadyCancelled: boolean };
  try {
    // Transactional so a fast double-click only cancels once.
    result = await db.runTransaction(async (txn) => {
      const snap = await txn.get(ref);
      if (!snap.exists) throw new GuardRefused();
      // Id from the snapshot: older events may not store an `id` field.
      const event = { ...(snap.data() as CalendarEvent), id: snap.id };
      if (!input.guard(event)) throw new GuardRefused();
      const status = eventStatus(event);
      if (status === "cancelled") {
        // Idempotent: a second cancel still returns success.
        return { event, alreadyCancelled: true };
      }
      if (status === "completed" || status === "no_show") {
        throw new BadState("This meeting has already taken place.");
      }
      txn.update(ref, {
        status: "cancelled",
        cancelledAt: FieldValue.serverTimestamp(),
        cancelledByVisitor: true,
        cancelReason: "by_visitor",
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { event, alreadyCancelled: false };
    });
  } catch (err) {
    if (err instanceof GuardRefused) return { ok: false, code: "invalid" };
    if (err instanceof BadState) {
      return { ok: false, code: "bad_state", message: err.message };
    }
    console.error("[booking-changes] cancel txn failed", err);
    return { ok: false, code: "error" };
  }

  // A repeat cancel (double-click, retry) must not re-send the email or
  // re-fire the trigger and webhook.
  if (!result.alreadyCancelled) {
    const cancelledEvent = result.event;
    // After the response: a chat or message turn shouldn't wait on email, and
    // a slow webhook reply invites provider retries.
    runAfterResponse(() => deleteGoogleBookingCopy(cancelledEvent));
    runAfterResponse(() => runCancelSideEffects(cancelledEvent, input.note));
  }
  return { ok: true, ...result };
}

async function runCancelSideEffects(
  event: CalendarEvent,
  note: string,
): Promise<void> {
  if (!event.contactId) return;
  const db = getAdminDb();
  try {
    const [contactSnap, subSnap, pageSnap] = await Promise.all([
      db.collection("contacts").doc(event.contactId).get(),
      db.doc(`subAccounts/${event.subAccountId}`).get(),
      event.bookingPageSlug
        ? db
            .doc(
              `subAccounts/${event.subAccountId}/bookingPages/${event.bookingPageSlug}`,
            )
            .get()
        : Promise.resolve(null),
    ]);
    if (contactSnap.exists && subSnap.exists && emailIsConfigured()) {
      const contact = contactSnap.data() as Contact;
      const sub = subSnap.data() as SubAccountDoc;
      const page = (pageSnap?.data() ?? null) as BookingPage | null;
      const startAt = (
        event.startAt as { toDate?: () => Date } | null
      )?.toDate?.();
      const endAt = (
        event.endAt as { toDate?: () => Date } | null
      )?.toDate?.();
      if (
        contact.email &&
        !contact.emailOptedOut &&
        startAt instanceof Date &&
        endAt instanceof Date
      ) {
        const rendered = renderBookingCancelledEmail(
          {
            recipientName: contact.name ?? "",
            businessName: sub.name ?? "Booking",
            businessLogoUrl: sub.logoUrl,
            page: {
              name: page?.name ?? event.title ?? "Meeting",
              durationMinutes:
                page?.durationMinutes ??
                Math.max(15, Math.round((endAt.getTime() - startAt.getTime()) / 60_000)),
              timezone: page?.timezone ?? "UTC",
              payment: page?.payment ?? null,
              confirmationMessage: page?.confirmationMessage ?? "",
            },
            startAt,
            endAt,
            publicEventUrl: "",
          },
          "by_visitor",
        );
        try {
          await sendEmail({
            to: contact.email,
            subject: rendered.subject,
            text: rendered.text,
            html: rendered.html,
            replyTo: sub.replyToEmail ?? undefined,
            from: tenantFrom(sub),
            meter: { subAccountId: event.subAccountId },
          });
        } catch (err) {
          console.warn("[booking-changes] cancel email send failed", err);
        }
      }
    }
  } catch (err) {
    console.warn("[booking-changes] cancel side-effect read failed", err);
  }

  await recordBookingActivity(
    {
      id: event.id,
      title: event.title || "Meeting",
      contactId: event.contactId,
      bookingPageSlug: event.bookingPageSlug ?? null,
    },
    "booking_cancelled",
    { extra: note },
  );
  await fireBookingTrigger(
    {
      agencyId: event.agencyId,
      subAccountId: event.subAccountId,
      contactId: event.contactId,
    },
    "event_cancelled",
  );
  runAfterResponse(() => emitBookingWebhook({
    eventId: event.id,
    agencyId: event.agencyId,
    subAccountId: event.subAccountId,
    type: "booking_cancelled",
    cancelReason: note,
  }));
}

export type RescheduleBookingResult =
  | {
      ok: true;
      newStart: Date;
      newEnd: Date;
      newToken: string;
      publicEventUrl: string;
    }
  | { ok: false; code: "invalid" }
  | { ok: false; code: "bad_state"; message: string }
  | { ok: false; code: "slot_taken" }
  | { ok: false; code: "error" };

/**
 * Moves startAt/endAt in place so the event id and history stay, rotates the
 * public token (old links die), re-publishes reminders and sends a fresh
 * confirmation + ICS. Only slot-holding events (scheduled / awaiting_payment)
 * qualify; payment-pending events stay pending and the hold isn't extended.
 */
export async function rescheduleBooking(input: {
  eventId: string;
  newStart: Date;
  /** Null = keep the booking page's duration. */
  newEnd: Date | null;
  guard: BookingChangeGuard;
}): Promise<RescheduleBookingResult> {
  const { newStart } = input;
  if (Number.isNaN(newStart.getTime()) || newStart.getTime() <= Date.now()) {
    return { ok: false, code: "bad_state", message: "Choose a time in the future." };
  }

  const db = getAdminDb();
  const eventRef = db.collection("events").doc(input.eventId);
  const lookbackMs = 8 * 60 * 60_000;

  // Fetch Google busy for the new window outside the transaction (network
  // calls don't belong in a txn). The peek here is non-authoritative; the txn
  // re-reads. Narrowed to the assigned host. Fails open to internal data only.
  let externalBusy: BusyEventWithHost[] = [];
  {
    const peek = await eventRef.get();
    if (peek.exists) {
      const ev = peek.data() as CalendarEvent;
      const peekEnd =
        input.newEnd ?? new Date(newStart.getTime() + 24 * 60 * 60_000);
      externalBusy = await fetchExternalBusy(
        ev.subAccountId,
        {
          from: new Date(newStart.getTime() - lookbackMs),
          to: new Date(peekEnd.getTime() + 1000),
        },
        ev.assignedToUid ? { onlyUids: [ev.assignedToUid] } : {},
      );
    }
  }

  let outcome: {
    newToken: string;
    page: BookingPage;
    event: CalendarEvent;
    newEnd: Date;
  };
  try {
    outcome = await db.runTransaction(async (txn) => {
      const eventSnap = await txn.get(eventRef);
      if (!eventSnap.exists) throw new GuardRefused();
      const event = { ...(eventSnap.data() as CalendarEvent), id: eventSnap.id };
      if (!input.guard(event)) throw new GuardRefused();
      const status = eventStatus(event);
      if (status !== "scheduled" && status !== "awaiting_payment") {
        throw new BadState(
          status === "cancelled"
            ? "This booking was cancelled. Please re-book."
            : "This meeting can't be rescheduled.",
        );
      }
      if (!event.bookingPageSlug) {
        throw new BadState("Reschedule isn't available for this booking.");
      }

      // Read the page inside the txn so availability checks use the same config.
      const pageRef = db.doc(
        `subAccounts/${event.subAccountId}/bookingPages/${event.bookingPageSlug}`,
      );
      const pageSnap = await txn.get(pageRef);
      if (!pageSnap.exists) {
        throw new BadState(
          "The booking page is no longer available. Please cancel and re-book later.",
        );
      }
      const page = pageSnap.data() as BookingPage;
      const newEnd =
        input.newEnd ?? new Date(newStart.getTime() + page.durationMinutes * 60_000);
      if (newEnd <= newStart) throw new BadState("Pick a valid new time.");

      const queryFrom = new Date(newStart.getTime() - lookbackMs);
      const queryTo = new Date(newEnd.getTime() + 1000);
      const busySnap = await txn.get(
        db
          .collection("events")
          .where("subAccountId", "==", event.subAccountId)
          .where("startAt", ">=", queryFrom)
          .where("startAt", "<=", queryTo),
      );
      const busy: BusyEventWithHost[] = [];
      for (const d of busySnap.docs) {
        if (d.id === eventRef.id) continue; // skip our own slot
        const e = d.data() as CalendarEvent;
        // Imported Google events: free/busy already covers them, and they never
        // count as bookings or leave the CRM.
        if (isImportedEvent(e)) continue;
        const s = e.status ?? "scheduled";
        if (s !== "scheduled" && s !== "awaiting_payment") continue;
        const s2 = (e.startAt as { toDate?: () => Date } | null)?.toDate?.();
        const e2 = (e.endAt as { toDate?: () => Date } | null)?.toDate?.();
        if (!(s2 instanceof Date) || !(e2 instanceof Date)) continue;
        busy.push({ startAt: s2, endAt: e2, assignedToUid: e.assignedToUid ?? null });
      }
      busy.push(...externalBusy);
      const free = computeRescheduleAvailability({
        page,
        now: new Date(),
        fromInstant: new Date(newStart.getTime() - 1),
        toInstant: new Date(newEnd.getTime() + 1),
        busy,
        assignedToUid: event.assignedToUid ?? null,
      });
      const candidate: SlotCandidate = { startAt: newStart, endAt: newEnd };
      if (!isSlotAvailable(candidate, free)) throw new SlotConflict();

      const { token: newRawToken, hash: newHash } = issueEventToken(eventRef.id);
      const icsSequence = (event.icsSequence ?? 0) + 1;
      txn.update(eventRef, {
        startAt: newStart,
        endAt: newEnd,
        publicTokenHash: newHash,
        icsSequence,
        updatedAt: FieldValue.serverTimestamp(),
      });
      return {
        newToken: newRawToken,
        page,
        event: { ...event, publicTokenHash: newHash, icsSequence } as CalendarEvent,
        newEnd,
      };
    });
  } catch (err) {
    if (err instanceof GuardRefused) return { ok: false, code: "invalid" };
    if (err instanceof BadState) {
      return { ok: false, code: "bad_state", message: err.message };
    }
    if (err instanceof SlotConflict) return { ok: false, code: "slot_taken" };
    console.error("[booking-changes] reschedule txn failed", err);
    return { ok: false, code: "error" };
  }

  const { newToken, event, page, newEnd } = outcome;
  const publicEventUrl = buildEventPublicUrl(newToken);

  // Move the pushed Google copy, if any (best-effort).
  runAfterResponse(() => moveGoogleBookingCopy(event, newStart, newEnd));

  runAfterResponse(() =>
    runRescheduleSideEffects({
      event,
      page,
      newRawToken: newToken,
      publicEventUrl,
      startAt: newStart,
      endAt: newEnd,
    }),
  );

  return { ok: true, newStart, newEnd, newToken, publicEventUrl };
}

async function runRescheduleSideEffects(args: {
  event: CalendarEvent;
  page: BookingPage | undefined;
  newRawToken: string;
  publicEventUrl: string;
  startAt: Date;
  endAt: Date;
}): Promise<void> {
  const db = getAdminDb();
  const { event, page, newRawToken, publicEventUrl, startAt, endAt } = args;

  // Fresh schedule nonce so QStash dedup doesn't collapse onto the old reminders.
  if (page?.remindersEnabled || page?.smsRemindersEnabled) {
    await scheduleEventReminders({
      eventId: event.id,
      startAt,
      reminderOffsetsMinutes: page.reminderOffsetsMinutes,
      rawToken: newRawToken,
      pendingPayment: eventStatus(event) === "awaiting_payment",
      scheduleNonce: Date.now().toString(36),
      page,
    });
  }

  if (event.contactId) {
    await recordBookingActivity(
      {
        id: event.id,
        title: event.title || "Meeting",
        contactId: event.contactId,
        bookingPageSlug: event.bookingPageSlug ?? null,
      },
      "booking_rescheduled",
    );
    await fireBookingTrigger(
      {
        agencyId: event.agencyId,
        subAccountId: event.subAccountId,
        contactId: event.contactId,
      },
      "event_rescheduled",
    );
  }

  // ICS as an UPDATE with a higher sequence so calendar clients overwrite the entry.
  if (!event.contactId || !emailIsConfigured()) return;
  try {
    const [contactSnap, subSnap] = await Promise.all([
      db.collection("contacts").doc(event.contactId).get(),
      db.doc(`subAccounts/${event.subAccountId}`).get(),
    ]);
    if (!contactSnap.exists || !subSnap.exists) return;
    const contact = contactSnap.data() as Contact;
    const sub = subSnap.data() as SubAccountDoc;
    if (!contact.email || contact.emailOptedOut) return;

    const rendered = renderBookingConfirmationEmail({
      recipientName: contact.name ?? "",
      businessName: sub.name ?? "Booking",
      businessLogoUrl: sub.logoUrl,
      page: {
        name: page?.name ?? event.title ?? "Meeting",
        durationMinutes:
          page?.durationMinutes ??
          Math.max(15, Math.round((endAt.getTime() - startAt.getTime()) / 60_000)),
        timezone: page?.timezone ?? "UTC",
        payment: page?.payment ?? null,
        confirmationMessage: page?.confirmationMessage ?? "",
      },
      startAt,
      endAt,
      meetingUrl: event.meetingUrl ?? page?.meetingUrl ?? null,
      location: event.location || undefined,
      publicEventUrl,
    });
    rendered.subject = `Updated: ${rendered.subject.replace(/^Confirmed: /, "")}`;
    const ics = generateIcs({
      uid: event.id,
      domain: icsDomain(),
      startAt,
      endAt,
      summary: event.title || page?.name || "Meeting",
      description: page?.confirmationMessage ?? "",
      location: event.meetingUrl || page?.meetingUrl || event.location || "",
      method: "REQUEST",
      status: "CONFIRMED",
      sequence: event.icsSequence ?? 1,
      attendeeEmail: contact.email,
      attendeeName: contact.name ?? undefined,
      organizerEmail: sub.replyToEmail ?? undefined,
      organizerName: sub.name ?? undefined,
    });

    if (eventStatus(event) === "awaiting_payment") {
      // No ICS for unconfirmed holds (same as the book route).
      await sendEmail({
        to: contact.email,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        replyTo: sub.replyToEmail ?? undefined,
        from: tenantFrom(sub),
        meter: { subAccountId: event.subAccountId },
      });
      return;
    }

    // Shared wrapper so the From/Reply-To policy applies to the ICS path too.
    await sendEmail({
      from: tenantFrom(sub),
      to: contact.email,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      replyTo: sub.replyToEmail ?? undefined,
      subAccount: sub,
      meter: { subAccountId: event.subAccountId },
      attachments: [
        {
          filename: "invite.ics",
          content: Buffer.from(ics, "utf-8").toString("base64"),
        },
      ],
    });
  } catch (err) {
    console.warn("[booking-changes] reschedule email send failed", err);
  }
}
