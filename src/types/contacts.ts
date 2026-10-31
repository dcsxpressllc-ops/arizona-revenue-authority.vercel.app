import type { Timestamp, FieldValue } from "firebase/firestore";

/**
 * Stored as a free-form string (a UTM source like "google" can flow through);
 * the union lists the values the UI has badges for. "website" is the legacy
 * catch-all from before forms and chat were split. "facebook"/"instagram" are
 * stamped by the Meta webhook, not offered in manual create. "" = unknown.
 */
export type ContactSource =
  | "website-form"
  | "web-chat"
  | "booking-page"
  | "community"
  | "get-leads"
  | "website"
  | "referral"
  | "ads"
  | "other"
  | "facebook"
  | "instagram"
  // Webinar1 webhook, for a registrant with no matching contact.
  | "webinar"
  | "";

/**
 * Attribution from the visit that converted, forwarded by the hosted form.
 * Null on CSV/manual contacts. Kept on the contact (not the submission) so
 * later events like stage changes can still reference it.
 */
export interface ContactAttribution {
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  utmTerm: string | null;
  fbclid: string | null;
  gclid: string | null;
  landingPage: string | null;
  referrer: string | null;
}

export interface Contact {
  id: string;
  name: string;
  email: string;
  phone: string;
  company: string;
  /** Free-form, multi-line billing address. Snapshotted onto quotes/invoices
   *  when picked, so later edits don't change old docs. "" when unset. */
  address: string;
  source: ContactSource;
  tags: string[];
  pipelineStage: string | null;
  attribution: ContactAttribution | null;
  /**
   * Values keyed by {@link CustomFieldDef} `key`. Validated server-side
   * against the sub-account's definitions. Absent on older docs.
   */
  customFields?: Record<
    string,
    import("./custom-fields").CustomFieldValue
  > | null;
  agencyId: string;
  subAccountId: string;
  createdByUid: string;
  // Flipped by the unsubscribe page (email) and Twilio inbound STOP (sms).
  // Checked before every automated send.
  emailOptedOut: boolean;
  smsOptedOut: boolean;
  /**
   * Server-only: set when a broadcast email hard-bounced, cleared by a later
   * delivery. Audiences skip bounced contacts (reason "bounced").
   */
  emailBouncedAt?: Timestamp | FieldValue | null;
  /**
   * A2P 10DLC proof of consent from a form's `sms_consent` field: who agreed,
   * to what exact text, when and where. Historical evidence only;
   * `smsOptedOut` is the live send gate.
   */
  smsConsent?: {
    consented: boolean;
    /** Exact disclosure text shown at opt-in. */
    textShown: string;
    consentedAt: Timestamp | FieldValue | null;
    /** From attribution.landingPage. */
    sourceUrl: string | null;
    ip: string | null;
  } | null;
  /**
   * Separate from `smsOptedOut`: an SMS STOP doesn't stop calls and vice
   * versa. Checked by the outbound voice compliance gate. Operator-toggled
   * only. Undefined = not opted out.
   */
  voiceOptedOut?: boolean;
  /** Separate from SMS. Flipped by the WhatsApp inbound webhook on STOP and
   *  checked before any WhatsApp send (AI or manual). Undefined = not opted out. */
  whatsappOptedOut?: boolean;
  /** Last outbound AI call (campaign or click-to-call), for recently-called
   *  suppression without scanning campaigns. Undefined = never called. */
  lastOutboundCallAt?: Timestamp | FieldValue | null;
  /** Null for click-to-call. */
  lastOutboundCampaignId?: string | null;
  /** Drives the review-request cooldown. Undefined = never asked. */
  reviewRequestedAt?: Timestamp | FieldValue | null;
  /**
   * Page-scoped Meta id (PSID / IGSID), stamped by the Meta webhook. Meta DMs
   * carry no phone/email, so this is the only way to match later messages.
   */
  metaUserId?: string | null;
  /**
   * Best-effort location from ipapi.co at form submit, falling back to the
   * phone's country code (country only, no lat/lng). Null when neither resolved.
   */
  countryCode: string | null;
  country: string | null;
  city: string | null;
  lat: number | null;
  lng: number | null;
  /**
   * Defaults to the reserved "global" territory. null/undefined only on
   * older docs and reads as Global. Ignored unless territory scoping is on.
   */
  territoryId?: string | null;
  createdAt: Timestamp | FieldValue | null;
  updatedAt: Timestamp | FieldValue | null;
}

export type ContactFormData = Pick<
  Contact,
  "name" | "email" | "phone" | "company" | "address" | "source" | "tags"
> & {
  territoryId?: string | null;
  customFields?: Record<
    string,
    import("./custom-fields").CustomFieldValue
  > | null;
};

export type ActivityType =
  | "note_added"
  | "booking_created"
  | "pipeline_moved"
  | "task_completed"
  | "form_submitted"
  | "email_sent"
  // Broadcast engagement from Resend webhooks; first occurrence per send.
  | "email_opened"
  | "email_clicked"
  | "email_bounced"
  | "email_complained"
  | "sms_sent"
  | "whatsapp_sent"
  // Operator replies on Messenger / Instagram (/api/comms/meta/send).
  | "messenger_sent"
  | "instagram_sent"
  | "automation_started"
  | "automation_step_sent"
  | "automation_step_skipped"
  | "automation_completed"
  | "automation_failed"
  | "ai_reply_sent"
  | "ai_escalated"
  | "ai_skipped"
  // Outbound AI call placed after the compliance gate passed.
  | "voice_call_initiated"
  // AI call (either direction) ended on a known contact.
  | "voice_call_completed"
  // Forwarded call went unanswered and Missed Call Text Back texted the caller.
  | "missed_call"
  // Human browser-dialer call. Doc id dialer_<CallSid>; the Dial action
  // callback fills in outcome, duration and recording.
  | "call_placed"
  // See lib/quotes/lifecycle.ts.
  | "quote_sent"
  | "quote_viewed"
  | "quote_accepted"
  | "ai_agent_flagged"
  | "quote_declined"
  | "quote_marked_paid"
  | "review_requested"
  // One entry for the whole cascade; linked deals/quotes/tasks/events are
  // re-tagged without their own rows.
  | "contact_territory_changed"
  // `booking_page_booked` is a public booking; `booking_created` logs any new
  // calendar event. See src/lib/booking/lifecycle.ts.
  | "booking_page_booked"
  | "booking_payment_received"
  | "booking_cancelled"
  | "booking_rescheduled"
  | "booking_no_show"
  | "booking_completed"
  | "booking_reassigned"
  // Stripe confirmed the money on the sub-account's own Stripe (written by the
  // order reconciler). Not the same as `quote_marked_paid`, which is manual.
  | "order_paid"
  | "order_refunded"
  // What a paid product order delivered (community access or a download).
  | "product_delivered"
  | "delivery_failed"
  | "delivery_revoked"
  // The buyer's order confirmation email (buy links and checkout pages).
  | "order_confirmation_sent"
  | "order_confirmation_failed"
  // `webinar_registered` comes from the webhook or the CRM-side push; the rest
  // only from webhooks. completed = watched to (near) the end.
  | "webinar_registered"
  | "webinar_joined"
  | "webinar_completed"
  | "webinar_cta_clicked";

export interface Note {
  id: string;
  content: string;
  createdBy: string;
  createdAt: Timestamp | FieldValue | null;
}

export interface ActivityItem {
  id: string;
  type: ActivityType;
  content: string;
  createdAt: Timestamp | FieldValue | null;
  createdBy: string;
}
