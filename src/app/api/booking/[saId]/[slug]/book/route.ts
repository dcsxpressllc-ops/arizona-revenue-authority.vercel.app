import "server-only";
import { canTakePayment } from "@/lib/payments/can-take-payment";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import {
  emailIsConfigured,
  sendEmail,
  tenantFrom,
} from "@/lib/comms/resend";
import { buildPaypalAmountUrl } from "@/lib/paypal/payment-link";
import {
  computeAvailability,
  isSlotAvailable,
  type BusyEvent,
  type SlotCandidate,
} from "@/lib/booking/availability";
import { fetchExternalBusy } from "@/lib/booking/external-busy";
import {
  loadHostNotifyContact,
  loadHostUpcomingCounts,
  pickLeastLoadedHost,
} from "@/lib/booking/hosts";
import {
  buildEventPublicUrl,
  issueEventToken,
} from "@/lib/booking/event-token";
import {
  buildBookingIcsAttachment,
  icsDomain,
} from "@/lib/booking/ics-attachment";
import { reconcileBookingContact } from "@/lib/booking/contact-reconcile";
import {
  effectiveBookingLocation,
  eventLocationText,
} from "@/lib/booking/location";
import {
  bookingConfirmationSmsBody,
  sendBookingSms,
} from "@/lib/booking/sms";
import {
  bookingCalendarOwnerUid,
  emitBookingWebhook,
  fireBookingTrigger,
  pushBookingToGoogle,
  recordBookingActivity,
  schedulePaymentAutoExpire,
  scheduleEventReminders,
} from "@/lib/booking/lifecycle";
import {
  renderBookingConfirmationEmail,
  renderBookingHostNotificationEmail,
  renderBookingPaymentPendingEmail,
} from "@/lib/booking/email";
import { GLOBAL_TERRITORY_ID } from "@/types";
import type { BookingPage } from "@/types/booking";
import type { CalendarEvent } from "@/types/events";
import { isImportedEvent } from "@/types/events";
import type { SubAccountDoc } from "@/types/tenancy";
import { runAfterResponse } from "@/lib/server/after-response";

/**
 * Public booking submission. Unauthenticated: the slot is re-verified inside
 * a transaction (no double-book from a stale UI), rate-limited per IP and per
 * sub-account, drafts 404, and the intake payload is validated.
 *
 * On success: reconcile the contact by email, create the event with an HMAC
 * public token (only the hash is stored), send the confirmation or
 * payment-pending email, schedule reminders or the unpaid-hold expiry, and
 * fire the booking trigger.
 */

// Soft rate limits per IP and per sub-account, in-memory LRU.
const IP_HOURLY_CAP = 10;
const SUB_HOURLY_CAP = 100;
const WINDOW_MS = 60 * 60_000;
const ipHits = new Map<string, number[]>();
const subHits = new Map<string, number[]>();

function pushAndCheck(
  bucket: Map<string, number[]>,
  key: string,
  cap: number,
): boolean {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  const arr = (bucket.get(key) ?? []).filter((t) => t >= cutoff);
  if (arr.length >= cap) {
    bucket.set(key, arr);
    return true;
  }
  arr.push(now);
  bucket.set(key, arr);
  if (bucket.size > 5000) {
    const oldest = bucket.keys().next().value;
    if (oldest !== undefined) bucket.delete(oldest);
  }
  return false;
}

function getClientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface SubmittedSlot {
  startAt?: string;
  endAt?: string;
}

interface BookBody {
  slot?: SubmittedSlot;
  name?: string;
  email?: string;
  phone?: string;
  extras?: Record<string, string>;
  /** Requested host; only honoured when the page has `allowHostSelection`. */
  hostUid?: string;
  /** Booker's address, for "at your place" pages. */
  address?: string;
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ saId: string; slug: string }> },
) {
  const { saId, slug } = await ctx.params;
  const ip = getClientIp(request);
  if (pushAndCheck(ipHits, ip, IP_HOURLY_CAP)) {
    return NextResponse.json(
      { error: "Too many booking attempts. Try again later." },
      { status: 429 },
    );
  }
  if (pushAndCheck(subHits, saId, SUB_HOURLY_CAP)) {
    return NextResponse.json(
      { error: "Booking page is busy. Try again later." },
      { status: 429 },
    );
  }

  let body: BookBody;
  try {
    body = (await request.json()) as BookBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const name = (body.name ?? "").trim();
  const email = (body.email ?? "").trim().toLowerCase();
  const phone = (body.phone ?? "").trim();
  if (!name || name.length > 120) {
    return NextResponse.json(
      { error: "Name is required (max 120 chars)." },
      { status: 400 },
    );
  }
  if (!EMAIL_RE.test(email) || email.length > 200) {
    return NextResponse.json(
      { error: "A valid email is required." },
      { status: 400 },
    );
  }
  if (!phone || phone.length > 40) {
    return NextResponse.json(
      { error: "Phone is required." },
      { status: 400 },
    );
  }
  const slot = body.slot;
  if (!slot?.startAt || !slot?.endAt) {
    return NextResponse.json(
      { error: "Pick a time before booking." },
      { status: 400 },
    );
  }
  const slotStart = new Date(slot.startAt);
  const slotEnd = new Date(slot.endAt);
  if (
    Number.isNaN(slotStart.getTime()) ||
    Number.isNaN(slotEnd.getTime()) ||
    slotEnd <= slotStart
  ) {
    return NextResponse.json(
      { error: "Selected slot is invalid." },
      { status: 400 },
    );
  }

  const db = getAdminDb();
  const pageSnap = await db
    .doc(`subAccounts/${saId}/bookingPages/${slug}`)
    .get();
  if (!pageSnap.exists) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const page = pageSnap.data() as BookingPage;
  if (page.status !== "published") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Where the meeting happens; an on-site visit needs the booker's address.
  const pageLocation = effectiveBookingLocation(page);
  const address = typeof body.address === "string" ? body.address.trim() : "";
  if (pageLocation?.type === "their_address" && (!address || address.length > 300)) {
    return NextResponse.json(
      { error: "Please enter the address for the visit." },
      { status: 400 },
    );
  }
  const locationText = eventLocationText(pageLocation, { phone, address });

  // Page-defined required intake fields (the UI checks too).
  const extras: Record<string, string> = {};
  for (const f of page.intakeFields) {
    const raw = body.extras?.[f.id];
    const value = typeof raw === "string" ? raw.trim() : "";
    if (f.required && !value) {
      return NextResponse.json(
        { error: `Please answer: ${f.label}` },
        { status: 400 },
      );
    }
    if (value.length > 2000) {
      return NextResponse.json(
        { error: `Answer too long for "${f.label}"` },
        { status: 400 },
      );
    }
    if (f.type === "select" && value) {
      if (!(f.options ?? []).includes(value)) {
        return NextResponse.json(
          { error: `Invalid option for "${f.label}"` },
          { status: 400 },
        );
      }
    }
    if (value) extras[f.id] = value;
  }

  const subSnap = await db.doc(`subAccounts/${saId}`).get();
  if (!subSnap.exists) {
    return NextResponse.json({ error: "Sub-account missing" }, { status: 500 });
  }
  const sub = subSnap.data() as SubAccountDoc;
  const agencyId = sub.agencyId;

  // Payment only applies when the sub-account can collect (card or paypal.me),
  // so config drift can't produce a "Pay" button with nothing behind it.
  // Check both rails: testing PayPal alone would let Stripe-only workspaces
  // book paid slots for free.
  const paymentRequired = !!page.payment && canTakePayment(sub);

  // Transactional create: re-run availability over a tight window around the
  // slot and only write if it survives. A stale UI gets 409.
  const lookbackMs = 8 * 60 * 60_000;
  const queryFrom = new Date(slotStart.getTime() - lookbackMs);
  const queryTo = new Date(slotEnd.getTime() + 1000);
  const eventsRef = db.collection("events");
  const eventDocRef = eventsRef.doc(); // pre-allocate id for token mint
  const now = new Date();

  // Team mode assigns the least-loaded free host. Load is computed outside
  // the transaction; slightly stale is fine.
  const hosts = page.hosts ?? [];
  const teamMode = hosts.length > 0;
  // Requested host only on opted-in pages and only if it's a real host;
  // otherwise pooled assignment, so a forged hostUid changes nothing.
  const allowHostSelection = teamMode && page.allowHostSelection === true;
  const requestedHostUid = (body.hostUid ?? "").trim() || null;
  const selectedHostUid =
    allowHostSelection &&
    requestedHostUid &&
    hosts.some((h) => h.uid === requestedHostUid)
      ? requestedHostUid
      : null;
  const loadByHost = teamMode
    ? await loadHostUpcomingCounts(
        saId,
        hosts.map((h) => h.uid),
        now,
      )
    : new Map<string, number>();

  // Google busy blocks are fetched outside the transaction (no HTTP inside a
  // retrying txn), once, for the hosts who could take the booking.
  // Fail-open: on a Google error the re-verify uses internal data only.
  const externalBusy = await fetchExternalBusy(
    saId,
    { from: queryFrom, to: queryTo },
    teamMode
      ? {
          onlyUids: selectedHostUid
            ? [selectedHostUid]
            : hosts.map((h) => h.uid),
        }
      : {},
  );

  type CreatedPayload = {
    eventDocRef: FirebaseFirestore.DocumentReference;
    territoryId: string;
    contactId: string;
    contactCreated: boolean;
    title: string;
    rawToken: string;
    tokenHash: string;
    paymentLinkUrl: string | null;
    paymentHoldExpiresAt: Date | null;
    assignedToUid: string | null;
    assignedToName: string | null;
  };

  let created: CreatedPayload;
  try {
    created = await db.runTransaction(async (txn) => {
      const busySnap = await txn.get(
        eventsRef
          .where("subAccountId", "==", saId)
          .where("startAt", ">=", queryFrom)
          .where("startAt", "<=", queryTo),
      );
      // occupying: all busy events (single mode). sharedBusy: unassigned,
      // blocks every host. occupyingByHost: blocks only that host.
      const occupying: BusyEvent[] = [];
      const sharedBusy: BusyEvent[] = [];
      const occupyingByHost = new Map<string, BusyEvent[]>();
      for (const d of busySnap.docs) {
        const e = d.data() as CalendarEvent;
        // Imported Google events: free/busy already covers them, and they never
        // count as bookings or leave the CRM.
        if (isImportedEvent(e)) continue;
        const s = e.status ?? "scheduled";
        if (s !== "scheduled" && s !== "awaiting_payment") continue;
        const startVal = (
          e.startAt as { toDate?: () => Date } | null
        )?.toDate?.();
        const endVal = (e.endAt as { toDate?: () => Date } | null)?.toDate?.();
        if (!(startVal instanceof Date) || !(endVal instanceof Date)) continue;
        const be: BusyEvent = { startAt: startVal, endAt: endVal };
        occupying.push(be);
        const host = e.assignedToUid ?? null;
        if (host == null) {
          sharedBusy.push(be);
        } else {
          const arr = occupyingByHost.get(host) ?? [];
          arr.push(be);
          occupyingByHost.set(host, arr);
        }
      }

      // Google busy goes into the same buckets; it only blocks its own host.
      for (const x of externalBusy) {
        const be: BusyEvent = { startAt: x.startAt, endAt: x.endAt };
        occupying.push(be);
        if (x.assignedToUid == null) {
          sharedBusy.push(be);
        } else {
          const arr = occupyingByHost.get(x.assignedToUid) ?? [];
          arr.push(be);
          occupyingByHost.set(x.assignedToUid, arr);
        }
      }

      const candidate: SlotCandidate = { startAt: slotStart, endAt: slotEnd };
      let assignedToUid: string | null = null;
      let assignedToName: string | null = null;

      if (teamMode) {
        // A picked host is the only candidate; never silently reassign.
        const candidateHosts = selectedHostUid
          ? hosts.filter((h) => h.uid === selectedHostUid)
          : hosts;
        // Free if the slot survives shared busy plus the host's own bookings,
        // using the host's working hours. Same calculator as the public
        // availability, so the re-verify can't disagree with what was shown.
        const freeHosts = candidateHosts.filter((h) => {
          const hostBusy = occupyingByHost.get(h.uid) ?? [];
          const free = computeAvailability({
            page,
            now,
            fromInstant: new Date(slotStart.getTime() - 1),
            toInstant: new Date(slotEnd.getTime() + 1),
            busy: [...sharedBusy, ...hostBusy],
            workingHoursOverride:
              h.workingHours && h.workingHours.length > 0
                ? h.workingHours
                : undefined,
          });
          return isSlotAvailable(candidate, free);
        });
        const chosen = pickLeastLoadedHost(freeHosts, loadByHost);
        if (!chosen) throw new SlotConflict();
        assignedToUid = chosen.uid;
        assignedToName = chosen.name;
      } else {
        const free = computeAvailability({
          page,
          now,
          fromInstant: new Date(slotStart.getTime() - 1),
          toInstant: new Date(slotEnd.getTime() + 1),
          busy: occupying,
        });
        if (!isSlotAvailable(candidate, free)) {
          throw new SlotConflict();
        }
      }

      // Contact reconcile stays inside the txn: the query is cheap and it
      // avoids a compensating delete if a later step fails.
      const reconciled = await reconcileBookingContact({
        agencyId,
        subAccountId: saId,
        email,
        name,
        phone,
        phoneCountry: sub.defaultPhoneCountry ?? null,
        defaultTerritoryId: page.defaultTerritoryId,
      });

      const territoryId =
        page.defaultTerritoryId && page.defaultTerritoryId.length > 0
          ? page.defaultTerritoryId
          : GLOBAL_TERRITORY_ID;

      const status = paymentRequired ? "awaiting_payment" : "scheduled";
      let paymentLinkUrl: string | null = null;
      let paymentHoldExpiresAt: Date | null = null;
      if (paymentRequired && page.payment) {
        // Hold window belongs to the page, not the rail. Auto-expire keys off
        // it, so without it an unpaid card hold would lock the slot forever.
        paymentHoldExpiresAt = new Date(
          now.getTime() + page.payment.holdHours * 60 * 60_000,
        );
        // Card deposits need no URL; /e/[token] creates the Stripe session.
        if (sub.paypalConfig) {
          paymentLinkUrl = buildPaypalAmountUrl({
            paypal: sub.paypalConfig,
            amount: page.payment.amount,
            currency: page.payment.currency,
          });
        }
      }

      const title = `${page.name} — ${name}`;
      // Mint now so the hash is written atomically.
      const { token, hash } = issueEventToken(eventDocRef.id);

      const eventDoc = {
        id: eventDocRef.id,
        title,
        startAt: slotStart,
        endAt: slotEnd,
        contactId: reconciled.id,
        location: locationText,
        // Snapshot so editing the page later doesn't rewrite old invites.
        meetingUrl: page.meetingUrl ?? null,
        notes: extras
          ? Object.entries(extras)
              .map(([k, v]) => `${labelForField(page, k)}: ${v}`)
              .join("\n")
          : "",
        agencyId,
        subAccountId: saId,
        createdByUid: "booking-page",
        territoryId,
        status,
        source: "booking_page",
        bookingPageSlug: page.slug,
        publicTokenHash: hash,
        paymentRequired,
        paymentAmount: page.payment?.amount ?? null,
        paymentCurrency: page.payment?.currency ?? null,
        paymentLinkUrl,
        paidAt: null,
        paidByUid: null,
        paymentHoldExpiresAt,
        assignedToUid,
        assignedToName,
        cancelledAt: null,
        cancelledByVisitor: null,
        cancelReason: null,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };
      txn.set(eventDocRef, eventDoc);

      return {
        eventDocRef,
        territoryId,
        contactId: reconciled.id,
        contactCreated: reconciled.created,
        title,
        rawToken: token,
        tokenHash: hash,
        paymentLinkUrl,
        paymentHoldExpiresAt,
        assignedToUid,
        assignedToName,
      };
    });
  } catch (err) {
    if (err instanceof SlotConflict) {
      return NextResponse.json(
        {
          error:
            "That slot was just taken. Refresh the page and pick another time.",
        },
        { status: 409 },
      );
    }
    console.error("[booking/book] transaction failed", err);
    return NextResponse.json(
      { error: "Couldn't reserve the slot. Try again." },
      { status: 500 },
    );
  }

  // Side effects, best-effort.
  const publicEventUrl = buildEventPublicUrl(created.rawToken);
  const appHost = icsDomain();

  const calendarOwnerUid = bookingCalendarOwnerUid(page, created.assignedToUid);
  const googlePush = {
    eventId: created.eventDocRef.id,
    subAccountId: saId,
    calendarOwnerUid,
    title: created.title,
    description: [
      `${page.name} — booked via your booking page.`,
      `With: ${name}${email ? ` <${email}>` : ""}${phone ? ` · ${phone}` : ""}`,
      !page.googleMeet && page.meetingUrl ? `Join: ${page.meetingUrl}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    startAt: slotStart,
    endAt: slotEnd,
  };
  // A Meet link has to exist before the confirmation goes out, so that push
  // runs inline. Everything else pushes after the response.
  let meetingUrl = page.meetingUrl ?? null;
  if (page.googleMeet && calendarOwnerUid) {
    const pushed = await pushBookingToGoogle({
      ...googlePush,
      addMeet: true,
      fallbackJoinUrl: page.meetingUrl ?? null,
    });
    if (pushed.meetUrl) meetingUrl = pushed.meetUrl;
  } else {
    // Holds included; expiry deletes the copy. No-op when not connected.
    runAfterResponse(() => pushBookingToGoogle(googlePush));
  }

  if (emailIsConfigured()) {
    try {
      const rendered = paymentRequired
        ? renderBookingPaymentPendingEmail({
            recipientName: name,
            businessName: sub.name ?? "Booking",
            businessLogoUrl: sub.logoUrl,
            page: {
              name: page.name,
              durationMinutes: page.durationMinutes,
              timezone: page.timezone,
              payment: page.payment,
              confirmationMessage: page.confirmationMessage,
            },
            startAt: slotStart,
            endAt: slotEnd,
            publicEventUrl,
            paymentUrl: created.paymentLinkUrl,
            location: locationText || undefined,
          })
        : renderBookingConfirmationEmail({
            recipientName: name,
            businessName: sub.name ?? "Booking",
            businessLogoUrl: sub.logoUrl,
            page: {
              name: page.name,
              durationMinutes: page.durationMinutes,
              timezone: page.timezone,
              payment: page.payment,
              confirmationMessage: page.confirmationMessage,
            },
            startAt: slotStart,
            endAt: slotEnd,
            meetingUrl,
            location: locationText || undefined,
            publicEventUrl,
            // Chosen host (null in single/pooled mode).
            hostName: created.assignedToName,
          });

      // No ICS for unpaid holds.
      const attachments = !paymentRequired
        ? buildBookingIcsAttachment({
            eventId: created.eventDocRef.id,
            startAt: slotStart,
            endAt: slotEnd,
            domain: appHost,
            title: created.title,
            description: [
              page.confirmationMessage || "",
              created.assignedToName ? `With ${created.assignedToName}` : "",
            ]
              .filter(Boolean)
              .join("\n\n"),
            // A URL in LOCATION gets a clickable "Join" in calendar apps.
            location: meetingUrl || locationText,
            organizerEmail: sub.replyToEmail ?? undefined,
            organizerName: sub.name ?? undefined,
            attendeeEmail: email,
            attendeeName: name,
          })
        : undefined;

      await sendEmailWithIcs({
        to: email,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        replyTo: sub.replyToEmail ?? undefined,
        from: tenantFrom(sub),
        icsAttachment: attachments,
        meterSubAccountId: saId,
      });
    } catch (err) {
      console.warn("[booking/book] confirmation send failed", err);
    }
  }

  // Notify the assigned host (team mode, confirmed only). Best-effort.
  if (
    !paymentRequired &&
    created.assignedToUid &&
    created.assignedToName &&
    emailIsConfigured()
  ) {
    try {
      const hostContact = await loadHostNotifyContact(
        saId,
        created.assignedToUid,
      );
      if (hostContact) {
        const rendered = renderBookingHostNotificationEmail({
          hostName: hostContact.name,
          businessName: sub.name ?? "Booking",
          businessLogoUrl: sub.logoUrl,
          page: {
            name: page.name,
            durationMinutes: page.durationMinutes,
            timezone: page.timezone,
          },
          startAt: slotStart,
          endAt: slotEnd,
          customerName: name,
          customerEmail: email,
          customerPhone: phone,
          notes:
            [
              locationText ? `Where: ${locationText}` : "",
              ...Object.entries(extras).map(
                ([k, v]) => `${labelForField(page, k)}: ${v}`,
              ),
            ]
              .filter(Boolean)
              .join("\n") || null,
          manageUrl: publicEventUrl,
        });
        await sendEmail({
          to: hostContact.email,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
          from: tenantFrom(sub),
          subAccount: sub,
          meter: { subAccountId: saId },
        });
      }
    } catch (err) {
      console.warn("[booking/book] host notification send failed", err);
    }
  }

  // Holds get their text at mark-paid instead, alongside the confirmation email.
  if (page.smsRemindersEnabled && !paymentRequired) {
    await sendBookingSms({
      subAccountId: saId,
      sub,
      contactId: created.contactId,
      label: "booking confirmation",
      body: bookingConfirmationSmsBody({
        recipientName: name,
        businessName: sub.name ?? "us",
        pageName: page.name,
        startAt: slotStart,
        timezone: page.timezone,
        meetingUrl,
        location: locationText || null,
        publicEventUrl,
      }),
    });
  }

  // Reminders; for unpaid holds they're scheduled on mark-paid instead.
  if (page.remindersEnabled || page.smsRemindersEnabled) {
    await scheduleEventReminders({
      eventId: created.eventDocRef.id,
      startAt: slotStart,
      reminderOffsetsMinutes: page.reminderOffsetsMinutes,
      rawToken: created.rawToken,
      pendingPayment: paymentRequired,
      page,
    });
  }

  if (paymentRequired && created.paymentHoldExpiresAt) {
    await schedulePaymentAutoExpire({
      eventId: created.eventDocRef.id,
      expiresAt: created.paymentHoldExpiresAt,
    });
  }

  await recordBookingActivity(
    {
      id: created.eventDocRef.id,
      title: created.title,
      contactId: created.contactId,
      bookingPageSlug: page.slug,
    },
    "booking_page_booked",
  );
  await fireBookingTrigger(
    {
      agencyId,
      subAccountId: saId,
      contactId: created.contactId,
    },
    "event_booked",
  );
  runAfterResponse(() => emitBookingWebhook({
    eventId: created.eventDocRef.id,
    agencyId,
    subAccountId: saId,
    type: "booking_page_booked",
  }));

  // Redirect only for confirmed bookings; holds stay on the pay CTA.
  // booking_id + email let the destination de-dupe conversions and use pixel
  // Advanced Matching. A malformed URL just means no redirect.
  let redirectUrl: string | null = null;
  if (!paymentRequired && page.redirectUrl) {
    try {
      const u = new URL(page.redirectUrl);
      // Append unless opted out (absent field = append).
      if (page.redirectAppendParams !== false) {
        u.searchParams.set("booking_id", created.eventDocRef.id);
        u.searchParams.set("email", email);
      }
      redirectUrl = u.toString();
    } catch (err) {
      console.warn("[booking/book] invalid redirectUrl, skipping", err);
    }
  }

  return NextResponse.json({
    ok: true,
    eventId: created.eventDocRef.id,
    status: paymentRequired ? "awaiting_payment" : "scheduled",
    paymentUrl: created.paymentLinkUrl ?? null,
    publicEventUrl,
    confirmationMessage: page.confirmationMessage || null,
    redirectUrl,
  });
}

class SlotConflict extends Error {}

function labelForField(page: BookingPage, id: string): string {
  return page.intakeFields.find((f) => f.id === id)?.label ?? id;
}

// ICS send goes through sendEmail so the From/Reply-To policy still applies.

interface SendWithIcs {
  to: string;
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
  from?: string;
  icsAttachment?: { filename: string; content: string };
  /** Workspace whose emailsSent usage ledger to increment. */
  meterSubAccountId?: string;
}

async function sendEmailWithIcs(input: SendWithIcs): Promise<void> {
  await sendEmail({
    to: input.to,
    subject: input.subject,
    text: input.text,
    html: input.html,
    replyTo: input.replyTo,
    from: input.from,
    meter: input.meterSubAccountId
      ? { subAccountId: input.meterSubAccountId }
      : null,
    ...(input.icsAttachment
      ? {
          attachments: [
            {
              filename: input.icsAttachment.filename,
              content: input.icsAttachment.content,
            },
          ],
        }
      : {}),
  });
}
