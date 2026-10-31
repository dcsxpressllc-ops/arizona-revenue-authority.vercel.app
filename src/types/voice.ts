import type { Timestamp, FieldValue } from "firebase/firestore";

/**
 * One AI-handled phone call: `subAccounts/{subAccountId}/voiceCalls/{callId}`.
 * Doc id = Vapi `call.id`, so retried webhooks are idempotent. Written
 * server-side by /api/webhooks/vapi/end-of-call/[subAccountId]; members read it for the
 * operator console. The transcript is small and lives inline.
 */

export interface VoiceTranscriptTurn {
  role: "assistant" | "user" | "system";
  content: string;
  /** Relative offset, so the UI doesn't depend on clock/timezone. */
  secondsFromStart: number | null;
}

export interface VoiceCall {
  id: string;
  agencyId: string;
  subAccountId: string;
  /** Same as `id`. */
  callId: string;
  /** E.164 from caller ID. Null for web-call tests from Vapi's Talk widget. */
  callerPhone: string | null;
  /** The number that was dialled (our Twilio / Vapi number). */
  toPhone: string | null;
  /** Older docs predate outbound calling and read as "inbound". */
  direction: "inbound" | "outbound";
  durationSec: number;
  summary: string | null;
  /** Free-form Vapi value, e.g. "customer-ended-call", "silence-timeout". */
  endedReason: string | null;
  /** Null when the call gave nothing to reconcile on. */
  contactId: string | null;
  /** True when a new Contact was created rather than matched. */
  contactCreated: boolean;
  /** From Vapi's structured-data extraction; drives the follow-up Task. */
  callbackRequested: boolean;
  /**
   * Stamped by the booking loop during the call so the end-of-call handler
   * can create the right Task (a caller who books never sets
   * callbackRequested). Phone bookings send no confirmation email, which the
   * Task calls out. Absent if booking was never touched.
   * attemptedAt = caller entered the booking flow; booked = an event was created.
   */
  voiceBooking?: {
    attemptedAt?: string | null;
    booked?: { eventId: string; startAtIso: string } | null;
  } | null;
  capturedName: string | null;
  capturedEmail: string | null;
  capturedPhone: string | null;
  /** Follow-up Task, if one was created. */
  taskId: string | null;
  escalationEmailSent: boolean;
  transcript: VoiceTranscriptTurn[];
  /** From status-update webhooks during the call, e.g. "in-progress". */
  liveStatus: string | null;
  liveStatusAt: Timestamp | FieldValue | null;
  /** Non-fatal end-of-call errors (task/email failures). */
  errors: string[];
  createdAt: Timestamp | FieldValue | null;
}
