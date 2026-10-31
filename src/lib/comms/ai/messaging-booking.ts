import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import type { AiChatMessage } from "@/lib/comms/ai/openrouter";
import {
  buildBookingToolsBlock,
  toChangeTargets,
  type ChangeTarget,
  type ChangeToolResult,
} from "@/lib/comms/ai/booking-tools";
import {
  buildBookingStateBlock,
  callAiWithBookingTools,
  liveOffer,
  offerKeys,
  toStoredOffer,
  type BookingTurnResult,
  type StoredBookingOffer,
} from "@/lib/comms/ai/booking-turn";
import {
  canChangeBooking,
  checkBookingCaps,
  countBooking,
  countBookingChange,
} from "@/lib/comms/ai/booking-caps";
import {
  bookAgentSlot,
  findRecentAgentBooking,
  type AgentBookResult,
  getAgentBookingContext,
  loadChangeableBookings,
} from "@/lib/server/agent-booking-service";
import {
  cancelBooking,
  rescheduleBooking,
} from "@/lib/server/booking-changes-service";
import type { BookingPage, IntakeField } from "@/types/booking";
import type { Contact } from "@/types/contacts";
import type { ResolvedAiAgent } from "@/types/ai";

/**
 * Live booking on the messaging channels (SMS, WhatsApp, Messenger,
 * Instagram), on top of the shared booking turn. The contact is already known
 * from their number or platform account, so any of their upcoming booking-page
 * bookings can be moved or cancelled. Offered times live on the conversation
 * doc (`conversations/{contactId}.bookingOffer`).
 */

/** How far back a provider retry of the same message can still find its booking. */
const REPLAY_WINDOW_MS = 15 * 60 * 1000;

export interface PreparedMessagingBooking {
  /** Null = no new bookings (no page set, or not bookable); changes may still run. */
  page: BookingPage | null;
  intake: IntakeField[] | null;
  changeable: ChangeTarget[];
  offer: StoredBookingOffer | null;
  promptBlock: string;
}

async function loadConversationOffer(
  contactId: string,
): Promise<StoredBookingOffer | null> {
  try {
    const snap = await getAdminDb().doc(`conversations/${contactId}`).get();
    return (snap.data()?.bookingOffer as StoredBookingOffer | undefined) ?? null;
  } catch {
    return null;
  }
}

async function saveConversationOffer(
  contactId: string,
  offer: StoredBookingOffer | null,
): Promise<void> {
  // Only on an existing conversation doc: the inbound upsert created it.
  await getAdminDb()
    .doc(`conversations/${contactId}`)
    .update({ bookingOffer: offer, updatedAt: FieldValue.serverTimestamp() });
}

/** Null when there's nothing to offer: no bookable page and no upcoming bookings. */
export async function prepareMessagingBooking(input: {
  subAccountId: string;
  agent: ResolvedAiAgent;
  contact: Contact;
}): Promise<PreparedMessagingBooking | null> {
  const { subAccountId, agent, contact } = input;
  // Choosing a messaging booking page is the opt-in for booking AND changes,
  // so pulling this code changes nothing until an admin sets one.
  const slug = agent.profile.messagingBookingPageSlug ?? null;
  if (!slug) return null;

  const [ctx, bookings, storedOffer] = await Promise.all([
    getAgentBookingContext(subAccountId, slug).catch(() => null),
    loadChangeableBookings({ subAccountId, contactId: contact.id }).catch(() => []),
    loadConversationOffer(contact.id),
  ]);
  if (ctx && !ctx.bookable) {
    console.warn(
      `[ai/messaging-booking] page "${slug}" not bookable (${ctx.reason}) sa=${subAccountId}; using the booking link`,
    );
  }
  const page = ctx?.bookable ? ctx.page : null;
  const changeable = toChangeTargets(bookings);
  if (!page && changeable.length === 0) return null;

  const intake =
    page && agent.profile.bookingAskIntake === true && page.intakeFields.length > 0
      ? page.intakeFields
      : null;
  // A stored new-booking offer only counts while it's for the current page.
  const fresh = liveOffer(storedOffer);
  const offer =
    fresh && (fresh.moveEventId || (page && fresh.pageSlug === page.slug)) ? fresh : null;

  const tools = buildBookingToolsBlock(page, "messaging", { intake, changeable, knownPhone: !!contact.phone });
  const state = buildBookingStateBlock({
    bookedLabels: [],
    limitReached:
      checkBookingCaps({ subAccountId, conversationKey: `contact:${contact.id}` }) === "chat",
    known: { name: contact.name, email: contact.email, phone: null },
    confirmKnown: false,
    offer,
    offerPage: page,
    changeable,
    picked: null,
  });
  return {
    page,
    intake,
    changeable,
    offer,
    promptBlock: [tools, state].filter(Boolean).join("\n\n"),
  };
}

/** The reply LLM call with booking tools. Throws only if the first call fails. */
export async function callAiWithMessagingBooking(input: {
  messages: AiChatMessage[];
  ai: { model?: string };
  booking: PreparedMessagingBooking;
  subAccountId: string;
  agencyId: string;
  contact: Contact;
}): Promise<BookingTurnResult> {
  const { booking, contact, subAccountId } = input;
  const conversationKey = `contact:${contact.id}`;
  const guard = (event: { subAccountId: string; contactId?: string | null }) =>
    event.subAccountId === subAccountId && event.contactId === contact.id;
  const page = booking.page;

  const cancel = async (target: ChangeTarget): Promise<ChangeToolResult> => {
    if (!canChangeBooking(conversationKey)) return { ok: false, code: "limit" };
    const r = await cancelBooking({
      eventId: target.booking.eventId,
      guard,
      note: "by attendee via an AI message conversation",
    });
    if (r.ok) countBookingChange(conversationKey);
    return r.ok ? { ok: true } : r;
  };
  const reschedule = async (
    target: ChangeTarget,
    startAtIso: string,
  ): Promise<ChangeToolResult> => {
    if (!canChangeBooking(conversationKey)) return { ok: false, code: "limit" };
    const r = await rescheduleBooking({
      eventId: target.booking.eventId,
      newStart: new Date(startAtIso),
      newEnd: null,
      guard,
    });
    if (r.ok) countBookingChange(conversationKey);
    return r.ok ? { ok: true } : r;
  };

  const result = await callAiWithBookingTools({
    messages: input.messages,
    ai: input.ai,
    tools: {
      audience: "messaging",
      subAccountId,
      page,
      intake: booking.intake,
      changeable: booking.changeable,
      knownPhone: !!contact.phone,
      book: async (req) => {
        if (!page) return { ok: false, code: "error" };
        const cap = checkBookingCaps({ subAccountId, conversationKey });
        if (cap !== "ok") return { ok: false, code: "limit", scope: cap };
        const r = await bookAgentSlot({
          subAccountId,
          agencyId: input.agencyId,
          page,
          channel: "messaging",
          startAtIso: req.startAtIso,
          name: req.name || contact.name || "",
          // The contact's own email first: reminders go there, and a texter
          // shouldn't be able to point business email at any address.
          email: contact.email?.trim() || req.email,
          // A number given in the conversation wins: "we call you" pages call it.
          phone: req.phone || contact.phone || null,
          contactId: contact.id,
          hostUid: req.hostUid,
          intakeAnswers: req.intakeAnswers,
          address: req.address,
        });
        if (r.ok) countBooking({ subAccountId, conversationKey });
        return r;
      },
      // A provider retry of the same message finds the booking the first
      // delivery made, instead of "that time was just taken".
      findExisting: async (req): Promise<AgentBookResult | null> => {
        if (!page) return null;
        const hit = await findRecentAgentBooking({
          subAccountId,
          contactId: contact.id,
          pageSlug: page.slug,
          startAtIso: req.startAtIso,
          withinMs: REPLAY_WINDOW_MS,
        });
        return hit ? { ok: true, ...hit } : null;
      },
      cancel,
      reschedule,
    },
    allowedKeys: new Set(offerKeys(booking.offer)),
    subAccountId,
    costSource: "replies",
  });

  // Keep the latest offer for the next message; clear it once something happened.
  const next = result.lastOffer
    ? toStoredOffer(result.lastOffer, "speech")
    : result.bookedLabel || result.changed
      ? null
      : undefined;
  if (next !== undefined) {
    await saveConversationOffer(contact.id, next).catch((err) =>
      console.warn(`[ai/messaging-booking] offer save failed sa=${subAccountId}`, err),
    );
  }
  return result;
}
