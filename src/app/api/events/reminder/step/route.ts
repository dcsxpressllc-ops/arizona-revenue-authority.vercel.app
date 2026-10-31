import "server-only";

import { NextResponse } from "next/server";

import { getAdminDb } from "@/lib/firebase/admin";
import {
  emailIsConfigured,
  sendEmail,
  tenantFrom,
} from "@/lib/comms/resend";
import { verifyQStashSignature } from "@/lib/automations/qstash";
import {
  buildEventPublicUrl,
  hashEventToken,
} from "@/lib/booking/event-token";
import { renderBookingReminderEmail } from "@/lib/booking/email";
import { bookingReminderSmsBody, sendBookingSms } from "@/lib/booking/sms";
import { eventStatus, eventOccupiesSlot } from "@/types/events";
import type { BookingPage } from "@/types/booking";
import type { CalendarEvent } from "@/types/events";
import type { Contact } from "@/types/contacts";
import type { SubAccountDoc } from "@/types/tenancy";

/**
 * QStash callback for one reminder (email and/or text, per the page's live
 * toggles), scheduled by scheduleEventReminders()
 * at booking (or at mark-paid for payment-gated events). No-ops with 200
 * when the event is gone, no longer holds a slot, is already in the past, or the token hash
 * changed (a reschedule rotates the token and publishes its own callbacks).
 * Send failures are logged and 200'd too; retrying a Resend 4xx is pointless.
 */

interface ReminderBody {
  eventId?: string;
  offsetMinutes?: number;
  token?: string;
  /** Channel snapshot from scheduling time; absent on older callbacks. */
  channels?: {
    email?: boolean;
    sms?: boolean;
    pageName?: string;
    timezone?: string;
  };
}

export async function POST(request: Request) {
  const signature = request.headers.get("Upstash-Signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 401 });
  }
  const rawBody = await request.text();
  const ok = await verifyQStashSignature(signature, rawBody);
  if (!ok) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let body: ReminderBody;
  try {
    body = JSON.parse(rawBody) as ReminderBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const eventId = body.eventId;
  const offsetMinutes = body.offsetMinutes;
  const token = body.token;
  if (
    !eventId ||
    typeof offsetMinutes !== "number" ||
    !token ||
    typeof token !== "string"
  ) {
    return NextResponse.json(
      { error: "eventId, offsetMinutes, and token are required" },
      { status: 400 },
    );
  }

  const db = getAdminDb();
  const eventSnap = await db.collection("events").doc(eventId).get();
  if (!eventSnap.exists) {
    return NextResponse.json({ ok: true, skipped: "missing" });
  }
  const event = eventSnap.data() as CalendarEvent;
  const status = eventStatus(event);
  if (!eventOccupiesSlot(status)) {
    return NextResponse.json({ ok: true, skipped: `status:${status}` });
  }
  if (status === "awaiting_payment") {
    // Mark-paid publishes fresh callbacks, so an awaiting_payment reminder is
    // always stale.
    return NextResponse.json({ ok: true, skipped: "awaiting_payment" });
  }
  const startAt = (
    event.startAt as { toDate?: () => Date } | null
  )?.toDate?.();
  if (!(startAt instanceof Date) || startAt.getTime() <= Date.now()) {
    return NextResponse.json({ ok: true, skipped: "past" });
  }
  if (event.publicTokenHash && event.publicTokenHash !== hashEventToken(token)) {
    // Token rotated by a reschedule; the new schedule has its own callbacks.
    return NextResponse.json({ ok: true, skipped: "rotated" });
  }

  if (!event.contactId) {
    return NextResponse.json({ ok: true, skipped: "no_contact" });
  }

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
  if (!contactSnap.exists || !subSnap.exists) {
    return NextResponse.json({ ok: true, skipped: "tenancy_missing" });
  }
  const contact = contactSnap.data() as Contact;
  const sub = subSnap.data() as SubAccountDoc;
  // Page may have been deleted since scheduling; fall back to event defaults.
  const page = (pageSnap?.data() ?? null) as BookingPage | null;
  const endAt = (
    event.endAt as { toDate?: () => Date } | null
  )?.toDate?.() ?? new Date(startAt.getTime() + 30 * 60_000);
  // Event snapshot first; older events without the field use the page value.
  const meetingUrl = event.meetingUrl ?? page?.meetingUrl ?? null;
  const publicEventUrl = buildEventPublicUrl(token);

  // Live page toggles win, so switching a channel off stops reminders already
  // scheduled. A deleted page falls back to the snapshot taken at scheduling,
  // then (older callbacks with no snapshot) to email only.
  const snap = body.channels;
  const emailOn = page
    ? page.remindersEnabled !== false
    : (snap?.email ?? true);
  const smsOn = page ? page.smsRemindersEnabled === true : snap?.sms === true;

  let smsResult: string | null = null;
  if (smsOn) {
    const sms = await sendBookingSms({
      subAccountId: event.subAccountId,
      sub,
      contactId: event.contactId,
      label: "booking reminder",
      body: bookingReminderSmsBody({
        businessName: sub.name ?? "us",
        pageName: page?.name ?? snap?.pageName ?? event.title ?? "Your meeting",
        startAt,
        timezone: page?.timezone ?? snap?.timezone ?? "UTC",
        meetingUrl,
        location: event.location || null,
        publicEventUrl,
      }),
    });
    smsResult = sms.sent ? "sent" : sms.reason;
  }

  if (!emailOn) {
    return NextResponse.json({ ok: true, sms: smsResult, email: "disabled" });
  }
  if (!emailIsConfigured()) {
    return NextResponse.json({
      ok: true,
      sms: smsResult,
      skipped: "email_not_configured",
    });
  }
  if (!contact.email || contact.emailOptedOut) {
    return NextResponse.json({
      ok: true,
      sms: smsResult,
      skipped: "opt_out_or_no_email",
    });
  }

  const rendered = renderBookingReminderEmail(
    {
      recipientName: contact.name ?? "",
      businessName: sub.name ?? "Booking",
      businessLogoUrl: sub.logoUrl,
      page: {
        name: page?.name ?? snap?.pageName ?? event.title ?? "Meeting",
        durationMinutes: page?.durationMinutes ?? Math.max(
          15,
          Math.round((endAt.getTime() - startAt.getTime()) / 60_000),
        ),
        timezone: page?.timezone ?? snap?.timezone ?? "UTC",
        payment: page?.payment ?? null,
        confirmationMessage: page?.confirmationMessage ?? "",
      },
      startAt,
      endAt,
      location: event.location || undefined,
      meetingUrl,
      publicEventUrl,
    },
    offsetMinutes,
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
    console.warn("[events/reminder] send failed", err);
  }

  return NextResponse.json({ ok: true });
}
