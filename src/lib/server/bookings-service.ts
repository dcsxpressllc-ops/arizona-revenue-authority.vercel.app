import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { emailIsConfigured, sendEmail, tenantFrom } from "@/lib/comms/resend";
import {
  buildEventPublicUrl,
  issueEventToken,
} from "@/lib/booking/event-token";
import { generateIcs } from "@/lib/booking/ics";
import {
  fireBookingTrigger,
  recordBookingActivity,
  scheduleEventReminders,
} from "@/lib/booking/lifecycle";
import { renderBookingConfirmationEmail } from "@/lib/booking/email";
import {
  bookingConfirmationSmsBody,
  sendBookingSms,
} from "@/lib/booking/sms";
import { eventStatus } from "@/types/events";
import type { BookingPage } from "@/types/booking";
import type { CalendarEvent } from "@/types/events";
import type { Contact } from "@/types/contacts";
import type { SubAccountDoc } from "@/types/tenancy";

/**
 * The one path that confirms a booking held in awaiting_payment, used by the
 * Stripe reconciler and the manual "Mark as paid" button so token rotation,
 * reminders, the ICS email, activity and the event_paid trigger can't diverge.
 *
 * The payment-pending email linked the original token, so a fresh one is minted
 * here and sent in the confirmation; a scraped old link can't be reused.
 * Callers do auth (route: membership; reconciler: Stripe signature).
 */

export type MarkBookingPaidOutcome =
  | { ok: true; status: "scheduled"; publicEventUrl: string }
  | {
      ok: false;
      code: "not_found" | "wrong_tenant" | "bad_status" | "write_failed";
      message: string;
      status?: string;
    };

export async function markBookingPaidServerSide(input: {
  eventId: string;
  expectSubAccountId: string;
  /** Null when Stripe confirmed it. */
  paidByUid: string | null;
}): Promise<MarkBookingPaidOutcome> {
  const db = getAdminDb();
  const eventRef = db.collection("events").doc(input.eventId);
  const eventSnap = await eventRef.get();
  if (!eventSnap.exists) {
    return { ok: false, code: "not_found", message: "Event not found" };
  }
  const event = eventSnap.data() as CalendarEvent;

  if (event.subAccountId !== input.expectSubAccountId) {
    return {
      ok: false,
      code: "wrong_tenant",
      message: "Event belongs to a different sub-account",
    };
  }

  // Replayed Stripe event or double click: already scheduled, so no second email
  // or reminder schedule.
  if (eventStatus(event) !== "awaiting_payment") {
    return {
      ok: false,
      code: "bad_status",
      message: "Only events awaiting payment can be marked paid.",
      status: eventStatus(event),
    };
  }

  const { token: newToken, hash: newHash } = issueEventToken(input.eventId);
  const icsSequence = (event.icsSequence ?? 0) + 1;
  try {
    await eventRef.update({
      status: "scheduled",
      paidAt: FieldValue.serverTimestamp(),
      paidByUid: input.paidByUid,
      publicTokenHash: newHash,
      icsSequence,
      paymentHoldExpiresAt: null,
      updatedAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error("[bookings-service] mark-paid update failed", err);
    return {
      ok: false,
      code: "write_failed",
      message: "Couldn't mark as paid.",
    };
  }

  const updatedEvent: CalendarEvent = {
    ...event,
    id: input.eventId,
    status: "scheduled",
    publicTokenHash: newHash,
    icsSequence,
  };
  await runMarkPaidSideEffects({ event: updatedEvent, rawToken: newToken });

  return {
    ok: true,
    status: "scheduled",
    publicEventUrl: buildEventPublicUrl(newToken),
  };
}

async function runMarkPaidSideEffects(args: {
  event: CalendarEvent;
  rawToken: string;
}): Promise<void> {
  const { event, rawToken } = args;
  const db = getAdminDb();
  const startAt = (
    event.startAt as { toDate?: () => Date } | null
  )?.toDate?.();
  const endAt = (
    event.endAt as { toDate?: () => Date } | null
  )?.toDate?.();
  if (!(startAt instanceof Date) || !(endAt instanceof Date)) return;

  if (!event.contactId) return;
  let page: BookingPage | null = null;
  let sub: SubAccountDoc | null = null;
  let contact: Contact | null = null;
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
    contact = (contactSnap.exists ? contactSnap.data() : null) as Contact | null;
    sub = (subSnap.exists ? subSnap.data() : null) as SubAccountDoc | null;
    page = (pageSnap?.data() ?? null) as BookingPage | null;
  } catch (err) {
    console.warn("[events/mark-paid] tenancy read failed", err);
  }

  const meetingUrl = event.meetingUrl ?? page?.meetingUrl ?? null;

  // Runs whether or not the email sent.
  if (page?.remindersEnabled || page?.smsRemindersEnabled) {
    await scheduleEventReminders({
      eventId: event.id,
      startAt,
      reminderOffsetsMinutes: page.reminderOffsetsMinutes,
      rawToken,
      pendingPayment: false,
      scheduleNonce: "paid",
      page,
    });
  }

  await recordBookingActivity(
    {
      id: event.id,
      title: event.title || "Meeting",
      contactId: event.contactId,
      bookingPageSlug: event.bookingPageSlug ?? null,
    },
    "booking_payment_received",
    {
      paymentAmount: event.paymentAmount ?? undefined,
      paymentCurrency: event.paymentCurrency ?? undefined,
    },
  );
  await fireBookingTrigger(
    {
      agencyId: event.agencyId,
      subAccountId: event.subAccountId,
      contactId: event.contactId,
    },
    "event_paid",
  );

  const publicEventUrl = buildEventPublicUrl(rawToken);

  if (page?.smsRemindersEnabled && sub) {
    await sendBookingSms({
      subAccountId: event.subAccountId,
      sub,
      contactId: event.contactId,
      label: "booking confirmation",
      body: bookingConfirmationSmsBody({
        recipientName: contact?.name ?? "",
        businessName: sub.name ?? "us",
        pageName: page.name,
        startAt,
        timezone: page.timezone,
        meetingUrl,
        location: event.location || null,
        publicEventUrl,
      }),
    });
  }

  if (!contact || !sub || !emailIsConfigured()) return;
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
    meetingUrl,
    location: event.location || undefined,
    publicEventUrl,
  });
  const appHost =
    process.env.NEXT_PUBLIC_APP_URL?.replace(/^https?:\/\//, "")
      ?.replace(/\/.*$/, "")
      ?.toLowerCase() ?? "leadstack.dev";
  const ics = generateIcs({
    uid: event.id,
    domain: appHost,
    startAt,
    endAt,
    summary: event.title || page?.name || "Meeting",
    description: page?.confirmationMessage ?? "",
    location: meetingUrl || event.location || "",
    method: "REQUEST",
    status: "CONFIRMED",
    sequence: event.icsSequence ?? 1,
    attendeeEmail: contact.email,
    attendeeName: contact.name ?? undefined,
    organizerEmail: sub.replyToEmail ?? undefined,
    organizerName: sub.name ?? undefined,
  });

  try {
    // Shared wrapper (supports attachments) so the ICS path can't bypass the
    // From/Reply-To policy.
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
    // Retry without the ICS so they at least get the text confirmation.
    console.warn("[events/mark-paid] resend-with-ics failed, retrying without", err);
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
    } catch (err2) {
      console.warn("[events/mark-paid] confirmation send failed", err2);
    }
  }
}
