import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import {
  computeAvailability,
  computeRescheduleAvailability,
  computeUnionAvailability,
  groupSlotsByLocalDate,
  isSlotAvailable,
  type BusyEvent,
  type BusyEventWithHost,
  type SlotCandidate,
} from "@/lib/booking/availability";
import { fetchExternalBusy } from "@/lib/booking/external-busy";
import {
  loadHostNotifyContact,
  loadHostUpcomingCounts,
  pickLeastLoadedHost,
} from "@/lib/booking/hosts";
import { buildEventPublicUrl, issueEventToken } from "@/lib/booking/event-token";
import {
  bookingCalendarOwnerUid,
  emitBookingWebhook,
  fireBookingTrigger,
  pushBookingToGoogle,
  recordBookingActivity,
  scheduleEventReminders,
} from "@/lib/booking/lifecycle";
import {
  renderBookingConfirmationEmail,
  renderBookingHostNotificationEmail,
} from "@/lib/booking/email";
import {
  buildBookingIcsAttachment,
  icsDomain,
} from "@/lib/booking/ics-attachment";
import { bookingConfirmationSmsBody, sendBookingSms } from "@/lib/booking/sms";
import { emailIsConfigured, sendEmail, tenantFrom } from "@/lib/comms/resend";
import { normalizePhoneLenient } from "@/lib/contacts/phone";
import {
  effectiveBookingLocation,
  eventLocationText,
} from "@/lib/booking/location";
import { emitContactCreatedById } from "@/lib/server/contacts-service";
import { eventOccupiesSlot, eventStatus, isImportedEvent } from "@/types/events";
import { GLOBAL_TERRITORY_ID } from "@/types";
import type { BookingPage } from "@/types/booking";
import type { CalendarEvent } from "@/types/events";
import type { SubAccountDoc } from "@/types/tenancy";
import { runAfterResponse } from "@/lib/server/after-response";

/**
 * Booking done by the AI agent inside a conversation: slot listing plus a
 * transactional book. Used by the phone agent (Vapi LLM webhook) and by the
 * website widget, typed or spoken (respondToWebChat).
 *
 * Reuses the public booking route's availability, host assignment and event
 * helpers so an agent booking can't disagree with the public page. Common to
 * every channel: a 7-day horizon capped by visibleDays, intake fields waived,
 * and deposit pages refused (bookable: false).
 *
 * Phone bookings are phone-only (caller ID): no confirmation email or
 * reminders. Website bookings collect an email (typed) or a phone/email
 * (spoken) and get the same confirmation, text and reminders as the public
 * booking page.
 */

/** `messaging` = SMS, WhatsApp, Messenger or Instagram (contact already known). */
export type AgentBookingChannel = "phone" | "web-text" | "web-voice" | "messaging";

const AGENT_HORIZON_DAYS = 7;
/** Slots for the LLM are capped by day count, not a flat total: one busy day can
 *  have 6+ slots and would crowd out later days. The model offers at most 3. */
const MAX_DAYS_FOR_LLM = 3;
const MAX_SLOTS_PER_DAY_FOR_LLM = 8;
const BUSY_LOOKBACK_MS = 8 * 60 * 60_000;

const CHANNEL_COPY: Record<
  AgentBookingChannel,
  { createdByUid: string; notes: string; fallbackName: string }
> = {
  phone: {
    createdByUid: "voice-agent",
    notes: "Booked by phone via the AI voice agent.",
    fallbackName: "Phone booking",
  },
  "web-text": {
    createdByUid: "web-chat-agent",
    notes: "Booked in the website chat by the AI assistant.",
    fallbackName: "Web chat booking",
  },
  "web-voice": {
    createdByUid: "web-chat-agent",
    notes: "Booked by voice on the website by the AI assistant.",
    fallbackName: "Web voice booking",
  },
  messaging: {
    createdByUid: "messaging-agent",
    notes: "Booked in a message conversation by the AI assistant.",
    fallbackName: "Message booking",
  },
};

export interface AgentBookingContext {
  page: BookingPage;
  bookable: boolean;
  /** Why not bookable (logged, never shown to the visitor). */
  reason: string | null;
}

/**
 * The configured booking page, or null if the slug doesn't resolve.
 * `bookable: false` (unpublished, takes deposits) makes the agent fall back
 * to sharing the booking link.
 */
export async function getAgentBookingContext(
  subAccountId: string,
  slug: string,
): Promise<AgentBookingContext | null> {
  const snap = await getAdminDb()
    .doc(`subAccounts/${subAccountId}/bookingPages/${slug}`)
    .get();
  if (!snap.exists) return null;
  const page = snap.data() as BookingPage;
  if (page.status !== "published") {
    return { page, bookable: false, reason: "page_not_published" };
  }
  if (page.payment) {
    return { page, bookable: false, reason: "page_requires_payment" };
  }
  return { page, bookable: true, reason: null };
}

/** Next slots within the agent horizon, same computation as the public
 *  availability endpoint, truncated for a conversational offer. */
export async function listAgentSlots(
  subAccountId: string,
  page: BookingPage,
  /** Narrow to one host. Only honoured when `allowHostSelection` is on. */
  hostUid?: string | null,
): Promise<SlotCandidate[]> {
  const db = getAdminDb();
  const now = new Date();
  const horizonDays = Math.min(AGENT_HORIZON_DAYS, page.visibleDays || AGENT_HORIZON_DAYS);
  const toInstant = new Date(now.getTime() + horizonDays * 24 * 60 * 60_000);
  const queryFrom = new Date(now.getTime() - BUSY_LOOKBACK_MS);

  const busy: BusyEventWithHost[] = [];
  const eventsSnap = await db
    .collection("events")
    .where("subAccountId", "==", subAccountId)
    .where("startAt", ">=", queryFrom)
    .where("startAt", "<=", toInstant)
    .get();
  for (const d of eventsSnap.docs) {
    const e = d.data() as CalendarEvent;
    // Imported Google events: free/busy already covers them, and they never
    // count as bookings or leave the CRM.
    if (isImportedEvent(e)) continue;
    if (!eventOccupiesSlot(eventStatus(e))) continue;
    const startAt = (e.startAt as { toDate?: () => Date } | null)?.toDate?.();
    const endAt = (e.endAt as { toDate?: () => Date } | null)?.toDate?.();
    if (!(startAt instanceof Date) || !(endAt instanceof Date)) continue;
    busy.push({ startAt, endAt, assignedToUid: e.assignedToUid ?? null });
  }

  const hosts = page.hosts ?? [];
  const onlyHostUid =
    page.allowHostSelection === true &&
    hostUid &&
    hosts.some((h) => h.uid === hostUid)
      ? hostUid
      : null;

  // External calendars, same merge as the public route. Never throws.
  busy.push(
    ...(await fetchExternalBusy(
      subAccountId,
      { from: queryFrom, to: toInstant },
      hosts.length > 0 ? { onlyUids: hosts.map((h) => h.uid) } : {},
    )),
  );

  const slots =
    hosts.length > 0
      ? computeUnionAvailability({
          page,
          now,
          toInstant,
          busy,
          hostUids: hosts.map((h) => h.uid),
          onlyHostUid,
        })
      : computeAvailability({
          page,
          now,
          toInstant,
          busy: busy.map((b) => ({ startAt: b.startAt, endAt: b.endAt })),
        });
  const byDay = groupSlotsByLocalDate(slots, page.timezone);
  const out: SlotCandidate[] = [];
  for (const day of byDay.slice(0, MAX_DAYS_FOR_LLM)) {
    out.push(...day.slots.slice(0, MAX_SLOTS_PER_DAY_FOR_LLM));
  }
  return out;
}

/**
 * Times a booking could move to. Mirrors the reschedule re-verify in
 * booking-changes-service (same availability helper, occupying events, the
 * assigned host's Google busy) so an offered time isn't refused later.
 */
export async function listRescheduleSlots(
  subAccountId: string,
  page: BookingPage,
  event: { id: string; assignedToUid?: string | null },
): Promise<SlotCandidate[]> {
  const db = getAdminDb();
  const now = new Date();
  const horizonDays = Math.min(AGENT_HORIZON_DAYS, page.visibleDays || AGENT_HORIZON_DAYS);
  const toInstant = new Date(now.getTime() + horizonDays * 24 * 60 * 60_000);
  const queryFrom = new Date(now.getTime() - BUSY_LOOKBACK_MS);

  const busy: BusyEventWithHost[] = [];
  const eventsSnap = await db
    .collection("events")
    .where("subAccountId", "==", subAccountId)
    .where("startAt", ">=", queryFrom)
    .where("startAt", "<=", toInstant)
    .get();
  for (const d of eventsSnap.docs) {
    if (d.id === event.id) continue;
    const e = d.data() as CalendarEvent;
    if (isImportedEvent(e)) continue;
    if (!eventOccupiesSlot(eventStatus(e))) continue;
    const startAt = (e.startAt as { toDate?: () => Date } | null)?.toDate?.();
    const endAt = (e.endAt as { toDate?: () => Date } | null)?.toDate?.();
    if (!(startAt instanceof Date) || !(endAt instanceof Date)) continue;
    busy.push({ startAt, endAt, assignedToUid: e.assignedToUid ?? null });
  }
  busy.push(
    ...(await fetchExternalBusy(
      subAccountId,
      { from: queryFrom, to: toInstant },
      event.assignedToUid ? { onlyUids: [event.assignedToUid] } : {},
    )),
  );

  const slots = computeRescheduleAvailability({
    page,
    now,
    toInstant,
    busy,
    assignedToUid: event.assignedToUid ?? null,
  });
  const byDay = groupSlotsByLocalDate(slots, page.timezone);
  const out: SlotCandidate[] = [];
  for (const day of byDay.slice(0, MAX_DAYS_FOR_LLM)) {
    out.push(...day.slots.slice(0, MAX_SLOTS_PER_DAY_FOR_LLM));
  }
  return out;
}

/** An upcoming booking-page booking the agent may cancel or move. */
export interface ChangeableBooking {
  eventId: string;
  startAt: Date;
  page: BookingPage;
  assignedToUid: string | null;
  assignedToName: string | null;
}

/**
 * Upcoming, still-scheduled booking-page bookings, either every one of a
 * contact's or only the given event ids. An equality-only query plus in-memory
 * filtering, so no composite index is needed. Pages that no longer exist are
 * skipped (nothing to list times on).
 */
export async function loadChangeableBookings(input: {
  subAccountId: string;
  contactId?: string | null;
  eventIds?: string[];
}): Promise<ChangeableBooking[]> {
  const db = getAdminDb();
  const now = Date.now();
  let docs: FirebaseFirestore.DocumentSnapshot[] = [];
  if (input.eventIds && input.eventIds.length > 0) {
    docs = await db.getAll(
      ...input.eventIds.slice(0, 10).map((id) => db.collection("events").doc(id)),
    );
  } else if (input.contactId) {
    // Equality-only (no composite index). Narrowed to scheduled booking-page
    // events so a contact's other history can't crowd out upcoming bookings.
    const snap = await db
      .collection("events")
      .where("contactId", "==", input.contactId)
      .where("subAccountId", "==", input.subAccountId)
      .where("source", "==", "booking_page")
      .where("status", "==", "scheduled")
      .limit(300)
      .get();
    docs = snap.docs;
  } else {
    return [];
  }

  const candidates: { event: CalendarEvent; startAt: Date }[] = [];
  for (const d of docs) {
    if (!d.exists) continue;
    const e = { ...(d.data() as CalendarEvent), id: d.id };
    if (e.subAccountId !== input.subAccountId) continue;
    if (input.contactId && e.contactId !== input.contactId) continue;
    if (e.source !== "booking_page" || !e.bookingPageSlug) continue;
    if (eventStatus(e) !== "scheduled") continue;
    const startAt = (e.startAt as { toDate?: () => Date } | null)?.toDate?.();
    if (!(startAt instanceof Date) || startAt.getTime() <= now) continue;
    candidates.push({ event: e, startAt });
  }
  candidates.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());

  const pages = new Map<string, BookingPage | null>();
  const out: ChangeableBooking[] = [];
  for (const { event, startAt } of candidates.slice(0, 5)) {
    const slug = event.bookingPageSlug!;
    if (!pages.has(slug)) {
      const snap = await db
        .doc(`subAccounts/${input.subAccountId}/bookingPages/${slug}`)
        .get();
      pages.set(slug, snap.exists ? (snap.data() as BookingPage) : null);
    }
    const page = pages.get(slug);
    if (!page) continue;
    out.push({
      eventId: event.id,
      startAt,
      page,
      assignedToUid: event.assignedToUid ?? null,
      assignedToName: event.assignedToName ?? null,
    });
  }
  return out;
}

/**
 * A booking this contact already holds at exactly this start on this page,
 * made in the last few minutes, i.e. the result of an earlier delivery of the
 * same message. Only still-scheduled events count, so a booking that was
 * cancelled since is never replayed as "booked".
 */
export async function findRecentAgentBooking(input: {
  subAccountId: string;
  contactId: string;
  pageSlug: string;
  startAtIso: string;
  withinMs: number;
}): Promise<{ eventId: string; startAt: Date; endAt: Date; assignedToName: string | null } | null> {
  const start = new Date(input.startAtIso);
  if (Number.isNaN(start.getTime())) return null;
  const snap = await getAdminDb()
    .collection("events")
    .where("contactId", "==", input.contactId)
    .where("subAccountId", "==", input.subAccountId)
    .where("bookingPageSlug", "==", input.pageSlug)
    .where("status", "==", "scheduled")
    .limit(300)
    .get();
  const now = Date.now();
  for (const d of snap.docs) {
    const e = d.data() as CalendarEvent;
    if (e.subAccountId !== input.subAccountId) continue;
    if (e.bookingPageSlug !== input.pageSlug || eventStatus(e) !== "scheduled") continue;
    const startAt = (e.startAt as { toDate?: () => Date } | null)?.toDate?.();
    const endAt = (e.endAt as { toDate?: () => Date } | null)?.toDate?.();
    const createdAt = (e.createdAt as { toDate?: () => Date } | null)?.toDate?.();
    if (!(startAt instanceof Date) || !(endAt instanceof Date)) continue;
    if (startAt.getTime() !== start.getTime()) continue;
    if (!(createdAt instanceof Date) || now - createdAt.getTime() > input.withinMs) continue;
    return { eventId: d.id, startAt, endAt, assignedToName: e.assignedToName ?? null };
  }
  return null;
}

class SlotConflict extends Error {}

export type AgentBookResult =
  | {
      ok: true;
      eventId: string;
      startAt: Date;
      endAt: Date;
      assignedToName: string | null;
    }
  | { ok: false; code: "slot_taken" | "invalid_slot" | "error" };

export interface AgentBookInput {
  subAccountId: string;
  agencyId: string;
  page: BookingPage;
  channel: AgentBookingChannel;
  startAtIso: string;
  name: string;
  /** Website bookings: where the confirmation goes. Phone: host notification only. */
  email?: string | null;
  phone?: string | null;
  /**
   * Phone: the caller-ID match, if any (null creates a phone-first contact).
   * Website: required; the caller reconciles the visitor first so the chat
   * session is linked to the same contact.
   */
  contactId: string | null;
  /** Already resolved from a name by the caller. Only honoured on
   *  `allowHostSelection` pages. Null = pooled least-loaded assignment. */
  hostUid?: string | null;
  /** Phone only: Vapi call id. A successful booking is stamped onto
   *  voiceCalls/{callId} so the end-of-call handler creates a follow-up Task. */
  callId?: string | null;
  /** Answers to the page's intake questions, saved on the event notes. */
  intakeAnswers?: { label: string; value: string }[];
  /** The booker's address, for "at your place" pages. */
  address?: string | null;
  /**
   * Number for a "we call you" page when it differs from `phone` (a caller
   * asking to be called on another number). Contact matching keeps `phone`.
   */
  locationPhone?: string | null;
}

/**
 * Book one slot, mirroring the public route's transactional re-check and
 * event shape minus payment and intake fields.
 */
export async function bookAgentSlot(
  input: AgentBookInput,
): Promise<AgentBookResult> {
  const { subAccountId, agencyId, page, channel } = input;
  const isPhone = channel === "phone";
  const copy = CHANNEL_COPY[channel];
  const db = getAdminDb();

  const slotStart = new Date(input.startAtIso);
  if (Number.isNaN(slotStart.getTime()) || slotStart.getTime() <= Date.now()) {
    return { ok: false, code: "invalid_slot" };
  }
  const slotEnd = new Date(
    slotStart.getTime() + page.durationMinutes * 60_000,
  );
  const name = input.name.trim().slice(0, 120);
  const phone = (input.phone ?? "").trim().slice(0, 40);
  const email = (input.email ?? "").trim().toLowerCase().slice(0, 200);
  const locationText = eventLocationText(effectiveBookingLocation(page), {
    phone: (input.locationPhone ?? "").trim().slice(0, 40) || phone,
    address: (input.address ?? "").trim().slice(0, 300) || null,
  });
  const notes = [
    copy.notes,
    locationText ? `Where: ${locationText}` : "",
    ...(input.intakeAnswers ?? []).map((a) => `${a.label}: ${a.value}`),
  ]
    .filter(Boolean)
    .join("\n");

  const territoryId =
    page.defaultTerritoryId && page.defaultTerritoryId.length > 0
      ? page.defaultTerritoryId
      : GLOBAL_TERRITORY_ID;

  let contactId = input.contactId;
  if (!contactId) {
    if (!isPhone) {
      console.error(
        `[agent-booking] website booking without a contact sa=${subAccountId}`,
      );
      return { ok: false, code: "error" };
    }
    // Phone: no caller-ID match, so a new phone-first contact.
    const ref = await db.collection("contacts").add({
      name,
      email: "",
      phone,
      company: "",
      address: "",
      source: "voice",
      tags: [],
      pipelineStage: null,
      attribution: null,
      agencyId,
      subAccountId,
      createdByUid: "voice-agent",
      emailOptedOut: false,
      smsOptedOut: false,
      countryCode: null,
      country: null,
      city: null,
      lat: null,
      lng: null,
      territoryId,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    contactId = ref.id;
    void emitContactCreatedById({ subAccountId, agencyId, contactId: ref.id });
  } else {
    // Best-effort: fill blanks on the existing contact (reminders read the
    // contact's email and phone), never overwrite curated data.
    try {
      const snap = await db.collection("contacts").doc(contactId).get();
      const data = snap.data() ?? {};
      const patch: Record<string, unknown> = {};
      if (name && !(data.name as string | undefined)?.trim()) patch.name = name;
      if (!isPhone && email && !(data.email as string | undefined)?.trim()) {
        patch.email = email;
      }
      if (!isPhone && phone && !(data.phone as string | undefined)?.trim()) {
        // E.164 so inbound SMS and reminders match this contact.
        const sub = await loadSubAccount(subAccountId).catch(() => null);
        patch.phone = normalizePhoneLenient(phone, sub?.defaultPhoneCountry ?? null);
      }
      if (snap.exists && Object.keys(patch).length > 0) {
        patch.updatedAt = FieldValue.serverTimestamp();
        await snap.ref.update(patch);
      }
    } catch {
    }
  }

  // Transactional create with re-check, as in the book route.
  const queryFrom = new Date(slotStart.getTime() - BUSY_LOOKBACK_MS);
  const queryTo = new Date(slotEnd.getTime() + 1000);
  const eventsRef = db.collection("events");
  const eventDocRef = eventsRef.doc();
  const now = new Date();

  const hosts = page.hosts ?? [];
  const teamMode = hosts.length > 0;
  // A requested host only counts on opted-in pages and if it's a real host.
  const selectedHostUid =
    page.allowHostSelection === true &&
    input.hostUid &&
    hosts.some((h) => h.uid === input.hostUid)
      ? input.hostUid
      : null;
  const loadByHost = teamMode
    ? await loadHostUpcomingCounts(
        subAccountId,
        hosts.map((h) => h.uid),
        now,
      )
    : new Map<string, number>();

  // External calendars fetched outside the transaction, narrowed to candidate
  // hosts. Fail-open.
  const externalBusy = await fetchExternalBusy(
    subAccountId,
    { from: queryFrom, to: queryTo },
    teamMode
      ? {
          onlyUids: selectedHostUid
            ? [selectedHostUid]
            : hosts.map((h) => h.uid),
        }
      : {},
  );

  const resolvedContactId = contactId;
  let created: {
    title: string;
    rawToken: string;
    assignedToUid: string | null;
    assignedToName: string | null;
  };
  try {
    created = await db.runTransaction(async (txn) => {
      const busySnap = await txn.get(
        eventsRef
          .where("subAccountId", "==", subAccountId)
          .where("startAt", ">=", queryFrom)
          .where("startAt", "<=", queryTo),
      );
      const occupying: BusyEvent[] = [];
      const sharedBusy: BusyEvent[] = [];
      const occupyingByHost = new Map<string, BusyEvent[]>();
      for (const d of busySnap.docs) {
        const e = d.data() as CalendarEvent;
        // Imported Google events: free/busy already covers them, and they never
        // count as bookings or leave the CRM.
        if (isImportedEvent(e)) continue;
        if (!eventOccupiesSlot(eventStatus(e))) continue;
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

      // A host's external busy blocks only that host.
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
        // A specifically requested host is the only candidate; never silently
        // reassign. If their slot is gone it's a conflict.
        const candidateHosts = selectedHostUid
          ? hosts.filter((h) => h.uid === selectedHostUid)
          : hosts;
        const freeHosts = candidateHosts.filter((h) => {
          const hostBusy = occupyingByHost.get(h.uid) ?? [];
          const free = computeAvailability({
            page,
            now,
            fromInstant: new Date(slotStart.getTime() - 1),
            toInstant: new Date(slotEnd.getTime() + 1),
            busy: [...sharedBusy, ...hostBusy],
            // Each host against their own working hours.
            workingHoursOverride:
              h.workingHours && h.workingHours.length > 0
                ? h.workingHours
                : undefined,
            // The slot was already offered, so only check real conflicts, not the moving
            // min-notice window. Avoids a false "slot just got taken" mid-conversation.
            ignoreMinNotice: true,
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
          // Same as above: real conflicts only.
          ignoreMinNotice: true,
        });
        if (!isSlotAvailable(candidate, free)) throw new SlotConflict();
      }

      const title = `${page.name} — ${name || phone || copy.fallbackName}`;
      const { token, hash } = issueEventToken(eventDocRef.id);

      txn.set(eventDocRef, {
        id: eventDocRef.id,
        title,
        startAt: slotStart,
        endAt: slotEnd,
        contactId: resolvedContactId,
        location: locationText,
        meetingUrl: page.meetingUrl ?? null,
        notes,
        agencyId,
        subAccountId,
        createdByUid: copy.createdByUid,
        territoryId,
        status: "scheduled",
        source: "booking_page",
        bookingPageSlug: page.slug,
        publicTokenHash: hash,
        paymentRequired: false,
        paymentAmount: null,
        paymentCurrency: null,
        paymentLinkUrl: null,
        paidAt: null,
        paidByUid: null,
        paymentHoldExpiresAt: null,
        assignedToUid,
        assignedToName,
        cancelledAt: null,
        cancelledByVisitor: null,
        cancelReason: null,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { title, rawToken: token, assignedToUid, assignedToName };
    });
  } catch (err) {
    if (err instanceof SlotConflict) return { ok: false, code: "slot_taken" };
    console.error(
      `[agent-booking] transaction failed sa=${subAccountId} slug=${page.slug}`,
      err,
    );
    return { ok: false, code: "error" };
  }

  const googleDescription = [
    `${page.name} — ${copy.notes.charAt(0).toLowerCase()}${copy.notes.slice(1)}`,
    name || phone || email
      ? `With: ${name || "visitor"}${email && !isPhone ? ` <${email}>` : ""}${phone ? ` · ${phone}` : ""}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  // Post-write side effects, same as the route minus intake/payment.
  try {
    await recordBookingActivity(
      {
        id: eventDocRef.id,
        title: created.title,
        contactId: resolvedContactId,
        bookingPageSlug: page.slug,
      },
      "booking_page_booked",
    );
    await fireBookingTrigger(
      { agencyId, subAccountId, contactId: resolvedContactId },
      "event_booked",
    );
    runAfterResponse(() => emitBookingWebhook({
      eventId: eventDocRef.id,
      agencyId,
      subAccountId,
      type: "booking_page_booked",
    }));
  } catch (err) {
    console.warn("[agent-booking] side effects failed", err);
  }

  if (isPhone) {
    // Push to the owner's Google Calendar (with a Meet room when the page asks
    // for one; it's stored on the event). No-op if not connected.
    runAfterResponse(() => pushBookingToGoogle({
      eventId: eventDocRef.id,
      subAccountId,
      calendarOwnerUid: bookingCalendarOwnerUid(page, created.assignedToUid),
      addMeet: page.googleMeet === true,
      fallbackJoinUrl: page.meetingUrl ?? null,
      title: created.title,
      description: googleDescription,
      startAt: slotStart,
      endAt: slotEnd,
    }));
    await notifyHost({
      subAccountId,
      page,
      created,
      slotStart,
      slotEnd,
      customerName: name || phone || copy.fallbackName,
      customerEmail: email,
      customerPhone: phone,
      notes,
      manageUrl: null,
    });
    await stampPhoneBooking(subAccountId, input.callId ?? null, eventDocRef.id, slotStart);
  } else {
    // Confirmation, text, host email and reminders run after the reply so the
    // visitor isn't kept waiting. The Google push comes first because a Meet
    // link has to exist before the confirmation goes out.
    const rawToken = created.rawToken;
    runAfterResponse(() => sendConversationBookingFollowUps({
      subAccountId,
      page,
      eventId: eventDocRef.id,
      contactId: resolvedContactId,
      created,
      rawToken,
      slotStart,
      slotEnd,
      name,
      email,
      phone,
      notes,
      googleDescription,
      locationText,
      fallbackName: copy.fallbackName,
    }));
  }

  return {
    ok: true,
    eventId: eventDocRef.id,
    startAt: slotStart,
    endAt: slotEnd,
    assignedToName: created.assignedToName,
  };
}

async function loadSubAccount(subAccountId: string): Promise<SubAccountDoc | null> {
  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  return snap.exists ? (snap.data() as SubAccountDoc) : null;
}

/** Team mode only; best-effort. */
async function notifyHost(input: {
  subAccountId: string;
  page: BookingPage;
  created: { assignedToUid: string | null; assignedToName: string | null };
  slotStart: Date;
  slotEnd: Date;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  notes: string;
  manageUrl: string | null;
  sub?: SubAccountDoc | null;
}): Promise<void> {
  const { created, page } = input;
  if (!created.assignedToUid || !created.assignedToName || !emailIsConfigured()) {
    return;
  }
  try {
    const [hostContact, sub] = await Promise.all([
      loadHostNotifyContact(input.subAccountId, created.assignedToUid),
      input.sub !== undefined
        ? Promise.resolve(input.sub)
        : loadSubAccount(input.subAccountId),
    ]);
    if (!hostContact || !sub) return;
    const rendered = renderBookingHostNotificationEmail({
      hostName: hostContact.name,
      businessName: sub.name ?? "Booking",
      businessLogoUrl: sub.logoUrl,
      page: {
        name: page.name,
        durationMinutes: page.durationMinutes,
        timezone: page.timezone,
      },
      startAt: input.slotStart,
      endAt: input.slotEnd,
      customerName: input.customerName,
      customerEmail: input.customerEmail,
      customerPhone: input.customerPhone,
      notes: input.notes,
      manageUrl: input.manageUrl,
    });
    await sendEmail({
      to: hostContact.email,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      from: tenantFrom(sub),
      subAccount: sub,
      meter: { subAccountId: input.subAccountId },
    });
  } catch (err) {
    console.warn("[agent-booking] host notification send failed", err);
  }
}

/**
 * Stamp the booking onto the voiceCalls doc so end-of-call creates a follow-up
 * Task. A booking caller never sets callbackRequested and gets no confirmation
 * email, so the team needs the nudge. Merge only; end-of-call writes the doc.
 */
async function stampPhoneBooking(
  subAccountId: string,
  callId: string | null,
  eventId: string,
  slotStart: Date,
): Promise<void> {
  if (!callId) return;
  try {
    await getAdminDb()
      .doc(`subAccounts/${subAccountId}/voiceCalls/${callId}`)
      .set(
        {
          voiceBooking: {
            booked: { eventId, startAtIso: slotStart.toISOString() },
          },
        },
        { merge: true },
      );
  } catch (err) {
    console.warn("[agent-booking] booking stamp failed", err);
  }
}

/** Website bookings get what the public booking page sends. Every step is independent and best-effort. */
async function sendConversationBookingFollowUps(input: {
  subAccountId: string;
  page: BookingPage;
  eventId: string;
  contactId: string;
  created: { title: string; assignedToUid: string | null; assignedToName: string | null };
  rawToken: string;
  slotStart: Date;
  slotEnd: Date;
  name: string;
  email: string;
  phone: string;
  notes: string;
  googleDescription: string;
  /** Where it happens ("Video call", an address, a phone call…); "" when not set. */
  locationText: string;
  fallbackName: string;
}): Promise<void> {
  const { page, created, subAccountId } = input;
  const publicEventUrl = buildEventPublicUrl(input.rawToken);
  const sub = await loadSubAccount(subAccountId).catch(() => null);

  let meetingUrl = page.meetingUrl ?? null;
  try {
    const pushed = await pushBookingToGoogle({
      eventId: input.eventId,
      subAccountId,
      calendarOwnerUid: bookingCalendarOwnerUid(page, created.assignedToUid),
      addMeet: page.googleMeet === true,
      fallbackJoinUrl: page.meetingUrl ?? null,
      title: created.title,
      description: [
        input.googleDescription,
        !page.googleMeet && page.meetingUrl ? `Join: ${page.meetingUrl}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      startAt: input.slotStart,
      endAt: input.slotEnd,
    });
    if (pushed.meetUrl) meetingUrl = pushed.meetUrl;
  } catch (err) {
    console.warn("[agent-booking] google push failed", err);
  }

  if (input.email && sub && emailIsConfigured()) {
    try {
      const rendered = renderBookingConfirmationEmail({
        recipientName: input.name,
        businessName: sub.name ?? "Booking",
        businessLogoUrl: sub.logoUrl,
        page: {
          name: page.name,
          durationMinutes: page.durationMinutes,
          timezone: page.timezone,
          payment: page.payment,
          confirmationMessage: page.confirmationMessage,
        },
        startAt: input.slotStart,
        endAt: input.slotEnd,
        meetingUrl,
        location: input.locationText || undefined,
        publicEventUrl,
        hostName: created.assignedToName,
      });
      const ics = buildBookingIcsAttachment({
        eventId: input.eventId,
        startAt: input.slotStart,
        endAt: input.slotEnd,
        domain: icsDomain(),
        title: created.title,
        description: [
          page.confirmationMessage || "",
          created.assignedToName ? `With ${created.assignedToName}` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
        location: meetingUrl || input.locationText,
        organizerEmail: sub.replyToEmail ?? undefined,
        organizerName: sub.name ?? undefined,
        attendeeEmail: input.email,
        attendeeName: input.name,
      });
      await sendEmail({
        to: input.email,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        replyTo: sub.replyToEmail ?? undefined,
        from: tenantFrom(sub),
        meter: { subAccountId },
        attachments: [ics],
      });
    } catch (err) {
      console.warn("[agent-booking] confirmation send failed", err);
    }
  }

  await notifyHost({
    subAccountId,
    page,
    created,
    slotStart: input.slotStart,
    slotEnd: input.slotEnd,
    customerName: input.name || input.phone || input.fallbackName,
    customerEmail: input.email,
    customerPhone: input.phone,
    notes: input.notes,
    manageUrl: publicEventUrl || null,
    sub,
  });

  if (page.smsRemindersEnabled && sub) {
    try {
      await sendBookingSms({
        subAccountId,
        sub,
        contactId: input.contactId,
        label: "booking confirmation",
        body: bookingConfirmationSmsBody({
          recipientName: input.name,
          businessName: sub.name ?? "us",
          pageName: page.name,
          startAt: input.slotStart,
          timezone: page.timezone,
          meetingUrl,
          location: input.locationText || null,
          publicEventUrl,
        }),
      });
    } catch (err) {
      console.warn("[agent-booking] confirmation text failed", err);
    }
  }

  if (page.remindersEnabled || page.smsRemindersEnabled) {
    try {
      await scheduleEventReminders({
        eventId: input.eventId,
        startAt: input.slotStart,
        reminderOffsetsMinutes: page.reminderOffsetsMinutes,
        rawToken: input.rawToken,
        pendingPayment: false,
        page,
      });
    } catch (err) {
      console.warn("[agent-booking] reminder schedule failed", err);
    }
  }
}

/** e.g. "Tuesday, July 28 at 10:00 AM" in the page's timezone. Fed to the LLM. */
export function formatSlotForSpeech(startAt: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: timezone || "UTC",
    }).format(startAt);
  } catch {
    return startAt.toISOString();
  }
}

/** Short button label, e.g. "Tue, Oct 28, 10:00 AM", in the page's timezone. */
export function formatSlotForChip(startAt: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: timezone || "UTC",
    }).format(startAt);
  } catch {
    return startAt.toISOString();
  }
}
