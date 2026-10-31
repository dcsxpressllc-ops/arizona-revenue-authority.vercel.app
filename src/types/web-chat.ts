import type { Timestamp, FieldValue } from "firebase/firestore";

/**
 * One widget chat thread, keyed by a UUID the widget keeps in localStorage.
 * Starts anonymous; once a [[capture ...]] marker yields identity we create
 * or match a Contact and set `contactId`.
 *
 *   subAccounts/{subAccountId}/webChatSessions/{sessionId}
 *   subAccounts/{subAccountId}/webChatSessions/{sessionId}/messages/{messageId}
 *
 * Server-only writes (Admin SDK); members can read.
 */

export type WebChatSessionStatus = "active" | "closed" | "escalated";

export interface WebChatSession {
  id: string;
  agencyId: string;
  subAccountId: string;
  /** Once set, the contact context block is injected on every reply. */
  contactId: string | null;
  /** Host page at session start. */
  pageUrl: string | null;
  referrer: string | null;
  /** Lowercased Origin at create time, for debugging allowedDomains mismatches. */
  origin: string | null;
  visitorIp: string | null;
  visitorUserAgent: string | null;
  status: WebChatSessionStatus;
  messageCount: number;
  tokensUsed: number;
  /** What the capture marker extracted, kept even if Contact creation failed so we can relink without re-asking. */
  capturedName: string | null;
  capturedEmail: string | null;
  capturedPhone: string | null;
  /**
   * First time the form marker fired (or the form was filled/skipped). Used
   * to suppress the form server-side even if the model ignores "at most
   * once", and to tell the prompt the visitor is captured.
   */
  capturePromptShownAt: Timestamp | FieldValue | null;
  /** Visitor hit Skip; the bot won't ask again. */
  captureSkipped: boolean;
  /** Task created on capture. Null for anonymous sessions. */
  pendingFollowUpTaskId: string | null;
  /** Web Voice seconds as reported by ElevenLabs. Absent if voice was never used. */
  voiceSeconds?: number;
  /**
   * Times the assistant last offered for booking. The prompt replays them so
   * a later turn can copy the exact start value, and a booking may only use
   * one of these. Cleared on booking. Absent = nothing offered.
   */
  bookingOffer?: WebChatBookingOffer | null;
  /** Appointments the assistant booked in this chat. Absent = none. */
  bookings?: WebChatBooking[];
  createdAt: Timestamp | FieldValue | null;
  updatedAt: Timestamp | FieldValue | null;
  lastMessageAt: Timestamp | FieldValue | null;
}

export interface WebChatOfferedSlot {
  /** Exact ISO start, as the booking service expects it. */
  startIso: string;
  /** Short label in the booking page's timezone, e.g. "Tue, Jul 28, 10:00 AM". */
  label: string;
}

export interface WebChatBookingOffer {
  /** Page the times belong to. Absent on older offers, which are then ignored. */
  pageSlug?: string;
  slots: WebChatOfferedSlot[];
  /** Host the times were listed for (host-selection pages). Null = anyone. */
  hostUid: string | null;
  offeredAtMs: number;
  /** Set when the times are for moving this booking rather than a new one. */
  moveEventId?: string | null;
}

export interface WebChatBooking {
  eventId: string;
  startIso: string;
  label: string;
  bookedAtMs: number;
}

export interface WebChatMessage {
  id: string;
  agencyId: string;
  subAccountId: string;
  sessionId: string;
  direction: "inbound" | "outbound";
  /** What the visitor sees; markers are already stripped. */
  body: string;
  /** Outbound only. */
  tokens: number | null;
  aiGenerated: boolean;
  /** Spoken through Web Voice. Absent = typed. */
  via?: "voice";
  createdAt: Timestamp | FieldValue | null;
}
