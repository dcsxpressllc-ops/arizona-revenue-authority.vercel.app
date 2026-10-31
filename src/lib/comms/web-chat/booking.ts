import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import type { AiChatMessage } from "@/lib/comms/ai/openrouter";
import {
  buildBookingToolsBlock,
  toChangeTargets,
  type BookingAudience,
  type BookRequest,
  type BookToolResult,
  type ChangeTarget,
  type ChangeToolResult,
} from "@/lib/comms/ai/booking-tools";
import {
  buildBookingStateBlock,
  callAiWithBookingTools,
  liveOffer,
  matchPickedSlot,
  offerKeys,
  spreadSlots,
  toStoredOffer,
  type StoredBookingOffer,
} from "@/lib/comms/ai/booking-turn";
import {
  canChangeBooking,
  checkBookingCaps,
  countBooking,
  countBookingChange,
  MAX_BOOKINGS_PER_CONVERSATION,
} from "@/lib/comms/ai/booking-caps";
import {
  bookAgentSlot,
  formatSlotForChip,
  formatSlotForSpeech,
  getAgentBookingContext,
  loadChangeableBookings,
} from "@/lib/server/agent-booking-service";
import {
  cancelBooking,
  rescheduleBooking,
} from "@/lib/server/booking-changes-service";
import { reconcileContactFromCapture } from "@/lib/comms/web-chat/capture";
import {
  recordSessionBooking,
  setBookingOffer,
} from "@/lib/comms/web-chat/session";
import type { BookingPage, IntakeField } from "@/types/booking";
import type { WebChatOfferedSlot, WebChatSession } from "@/types/web-chat";

/**
 * Live booking inside the website widget (typed and Web Voice), on top of the
 * shared booking turn (comms/ai/booking-turn). Chat-specific parts: offered
 * times live on the session, a tapped time button arrives as `pickedSlot`,
 * the visitor's contact is linked to the session when they book, and the
 * chat can only cancel or move bookings it made itself (a web visitor can
 * claim anyone's email, so other bookings of the contact are off limits).
 */

/** Buttons shown under a reply. The prompt still sees the full list. */
const MAX_SLOT_BUTTONS = 6;

export interface PreparedWebChatBooking {
  page: BookingPage;
  audience: BookingAudience;
  /** Appended to the system prompt. */
  promptBlock: string;
  offer: StoredBookingOffer | null;
  changeable: ChangeTarget[];
  intake: IntakeField[] | null;
}

/**
 * Null when booking is off for this turn: no page configured, the page isn't
 * bookable (unpublished, takes deposits), or the page lookup failed. The
 * caller then keeps the plain booking-link behaviour.
 */
export async function prepareWebChatBooking(input: {
  subAccountId: string;
  bookingPageSlug: string | null | undefined;
  session: WebChatSession;
  isVoice: boolean;
  /** Start value of a time button the visitor just tapped (typed chat only). */
  pickedSlotIso: string | null;
  /** The workspace switched on "ask the booking page's questions". */
  askIntake: boolean;
}): Promise<PreparedWebChatBooking | null> {
  if (!input.bookingPageSlug) return null;
  const ctx = await getAgentBookingContext(
    input.subAccountId,
    input.bookingPageSlug,
  ).catch(() => null);
  if (!ctx) return null;
  if (!ctx.bookable) {
    console.warn(
      `[web-chat/booking] page "${input.bookingPageSlug}" not bookable (${ctx.reason}) sa=${input.subAccountId}; using the booking link`,
    );
    return null;
  }

  const audience: BookingAudience = input.isVoice ? "web-voice" : "web-text";
  const sessionEventIds = (input.session.bookings ?? []).map((b) => b.eventId);
  const changeable = toChangeTargets(
    sessionEventIds.length > 0
      ? await loadChangeableBookings({
          subAccountId: input.subAccountId,
          eventIds: sessionEventIds,
        }).catch(() => [])
      : [],
  );
  // A new-booking offer only counts while it's for the current page.
  const fresh = liveOffer(input.session.bookingOffer);
  const offer =
    fresh && (fresh.moveEventId || fresh.pageSlug === ctx.page.slug) ? fresh : null;
  const intake =
    input.askIntake && ctx.page.intakeFields.length > 0 ? ctx.page.intakeFields : null;

  const tools = buildBookingToolsBlock(ctx.page, audience, { intake, changeable });
  const state = buildBookingStateBlock({
    bookedLabels: changeable.map((t) =>
      formatSlotForSpeech(t.booking.startAt, t.booking.page.timezone),
    ),
    limitReached: sessionEventIds.length >= MAX_BOOKINGS_PER_CONVERSATION,
    known: {
      name: input.session.capturedName,
      email: input.session.capturedEmail,
      phone: input.session.capturedPhone,
    },
    confirmKnown: input.isVoice,
    offer,
    offerPage: ctx.page,
    changeable,
    picked: input.isVoice ? null : matchPickedSlot(offer, input.pickedSlotIso),
  });

  return {
    page: ctx.page,
    audience,
    promptBlock: [tools, state].filter(Boolean).join("\n\n"),
    offer,
    changeable,
    intake,
  };
}

export interface WebChatLlmResult {
  text: string;
  totalTokens: number;
  model: string;
  /** Contact the session is linked to after this turn (a booking can link one). */
  contactId: string | null;
  booked: boolean;
  /** Buttons to show under the reply (typed chat, new-booking times offered this turn). */
  slotButtons: WebChatOfferedSlot[] | null;
}

async function linkedContactEmail(contactId: string): Promise<string | null> {
  try {
    const snap = await getAdminDb().doc(`contacts/${contactId}`).get();
    const email = (snap.data()?.email as string | undefined)?.trim().toLowerCase();
    return email || null;
  } catch {
    return null;
  }
}

/**
 * The reply LLM call, plus up to two booking-tool rounds when booking is on.
 * Throws only if the first call fails (the caller shows its fallback).
 */
export async function callAiWithWebChatBooking(input: {
  messages: AiChatMessage[];
  ai: { model?: string; maxTokens?: number; temperature?: number };
  booking: PreparedWebChatBooking | null;
  subAccountId: string;
  /** Web Voice turns are priced by the minute, so their cost is tracked apart. */
  isVoice: boolean;
  agencyId: string;
  sessionId: string;
  session: WebChatSession;
  pageUrl: string | null;
  visitorIp: string | null;
}): Promise<WebChatLlmResult> {
  const { booking, session } = input;
  let contactId = session.contactId;
  const ip = input.visitorIp ?? session.visitorIp ?? null;
  const sessionEventIds = new Set((session.bookings ?? []).map((b) => b.eventId));
  let bookingsMade = sessionEventIds.size;

  const book = async (
    page: BookingPage,
    audience: BookingAudience,
    req: BookRequest,
  ): Promise<BookToolResult> => {
    if (bookingsMade >= MAX_BOOKINGS_PER_CONVERSATION) {
      return { ok: false, code: "limit", scope: "chat" };
    }
    const cap = checkBookingCaps({
      subAccountId: input.subAccountId,
      conversationKey: `web:${input.subAccountId}:${input.sessionId}`,
      ip,
    });
    if (cap !== "ok") return { ok: false, code: "limit", scope: cap };

    // Reminders go to the contact's email, so a linked contact with a
    // different email must not keep the booking; reconcile by the email
    // given here instead (the public booking page matches on email too).
    let existingContactId = contactId;
    let relinkByEmail = false;
    if (existingContactId && req.email) {
      const linkedEmail = await linkedContactEmail(existingContactId);
      if (linkedEmail && linkedEmail !== req.email) {
        existingContactId = null;
        relinkByEmail = true;
      }
    }
    const reconciled = await reconcileContactFromCapture({
      agencyId: input.agencyId,
      subAccountId: input.subAccountId,
      sessionId: input.sessionId,
      existingContactId,
      sessionContactId: contactId,
      pageUrl: input.pageUrl,
      // A phone match could land back on the old contact; match on the email only.
      capture: {
        name: req.name,
        email: req.email,
        phone: relinkByEmail ? null : req.phone,
      },
    });
    if (!reconciled) return { ok: false, code: "error" };
    contactId = reconciled.contactId;
    const result = await bookAgentSlot({
      subAccountId: input.subAccountId,
      agencyId: input.agencyId,
      page,
      channel: audience,
      startAtIso: req.startAtIso,
      name: req.name,
      email: req.email,
      phone: req.phone,
      contactId: reconciled.contactId,
      hostUid: req.hostUid,
      intakeAnswers: req.intakeAnswers,
      address: req.address,
    });
    if (result.ok) {
      bookingsMade += 1;
      countBooking({
        subAccountId: input.subAccountId,
        conversationKey: `web:${input.subAccountId}:${input.sessionId}`,
        ip,
      });
    }
    return result;
  };

  // Only bookings this chat made, re-checked inside the change transaction.
  const guard = (event: { id: string; subAccountId: string }) =>
    event.subAccountId === input.subAccountId && sessionEventIds.has(event.id);
  const changeKey = `web:${input.subAccountId}:${input.sessionId}`;
  const cancel = async (target: ChangeTarget): Promise<ChangeToolResult> => {
    if (!canChangeBooking(changeKey)) return { ok: false, code: "limit" };
    const r = await cancelBooking({
      eventId: target.booking.eventId,
      guard,
      note: "by attendee via the website chat",
    });
    if (r.ok) countBookingChange(changeKey);
    return r.ok ? { ok: true } : r;
  };
  const reschedule = async (
    target: ChangeTarget,
    startAtIso: string,
  ): Promise<ChangeToolResult> => {
    if (!canChangeBooking(changeKey)) return { ok: false, code: "limit" };
    const r = await rescheduleBooking({
      eventId: target.booking.eventId,
      newStart: new Date(startAtIso),
      newEnd: null,
      guard,
    });
    if (r.ok) countBookingChange(changeKey);
    return r.ok ? { ok: true } : r;
  };

  const page = booking?.page ?? null;
  const audience = booking?.audience ?? "web-text";
  const result = await callAiWithBookingTools({
    messages: input.messages,
    ai: input.ai,
    tools:
      booking && page
        ? {
            audience,
            subAccountId: input.subAccountId,
            page,
            intake: booking.intake,
            changeable: booking.changeable,
            book: (req) => book(page, audience, req),
            cancel,
            reschedule,
          }
        : null,
    allowedKeys: booking ? new Set(offerKeys(booking.offer)) : null,
    subAccountId: input.subAccountId,
    costSource: input.isVoice ? "webVoice" : "replies",
    onBooked: async (b) => {
      await recordSessionBooking({
        subAccountId: input.subAccountId,
        sessionId: input.sessionId,
        booking: {
          eventId: b.eventId,
          startIso: b.startAt.toISOString(),
          label: b.label,
          bookedAtMs: Date.now(),
        },
      });
    },
  });

  // Keep the latest offer for the next turn; clear it once something changed
  // (a booking already clears it in recordSessionBooking).
  const nextOffer = result.lastOffer
    ? toStoredOffer(result.lastOffer, "chip")
    : result.changed
      ? null
      : undefined;
  if (booking && nextOffer !== undefined) {
    await setBookingOffer({
      subAccountId: input.subAccountId,
      sessionId: input.sessionId,
      offer: nextOffer,
    }).catch((err) =>
      console.warn(`[web-chat/booking] offer save failed sa=${input.subAccountId}`, err),
    );
  }

  const offer = result.lastOffer;
  const slotButtons =
    booking?.audience === "web-text" && offer
      ? spreadSlots(offer.slots, offer.page.timezone, MAX_SLOT_BUTTONS).map((s) => ({
          startIso: s.startAt.toISOString(),
          label: formatSlotForChip(s.startAt, offer.page.timezone),
        }))
      : null;

  return {
    text: result.text,
    totalTokens: result.totalTokens,
    model: result.model,
    contactId,
    booked: result.bookedLabel !== null,
    slotButtons,
  };
}
