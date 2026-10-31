import type { Timestamp, FieldValue } from "firebase/firestore";

/**
 * SMS thread: `contacts/{contactId}/messages/{messageId}`. Only written when
 * the sub-account has `twilioConfig.enabled`; shared-sender mode just logs
 * `sms_sent` activities.
 *
 * Inbound doc id = Twilio MessageSid so retries dedupe with a merge set.
 * Outbound rows use an auto-id and get twilioMessageSid stamped once the API
 * returns.
 */

export type MessageDirection = "inbound" | "outbound";

export type MessageStatus =
  /** Waiting on the Twilio API response. */
  | "queued"
  /** Twilio accepted it; most outbound rows settle here. */
  | "sent"
  /** `error` is set. */
  | "failed"
  /** Every inbound row. */
  | "received";

export interface MessageDoc {
  id: string;
  /** Mirrored from the parent contact for rules and queries. */
  agencyId: string;
  subAccountId: string;
  contactId: string;
  direction: MessageDirection;
  status: MessageStatus;
  /** Twilio caps SMS at 1600 chars. */
  body: string;
  /** E.164. Outbound: our fromNumber. Inbound: the contact. */
  from: string;
  /** E.164. Outbound: the contact. Inbound: our fromNumber. */
  to: string;
  twilioMessageSid: string | null;
  /** Null for automation sends. */
  sentByUid: string | null;
  error: string | null;
  createdAt: Timestamp | FieldValue | null;
  /** Set when a user opens the Messages tab; drives unread badges. */
  readAt: Timestamp | FieldValue | null;
}

/**
 * Email thread: `contacts/{contactId}/emailMessages/{messageId}`. Only used
 * when `resendConfig.inboxEnabled` is on a verified domain. Inbound rows come
 * from the Resend `email.received` webhook (doc id = Resend email id, so
 * retries dedupe); outbound rows come from the manual send paths. Broadcast
 * and workflow sends switch Reply-To to the capture address but don't write
 * thread rows.
 */
export interface EmailMessageDoc {
  id: string;
  agencyId: string;
  subAccountId: string;
  contactId: string;
  direction: MessageDirection;
  status: MessageStatus;
  subject: string;
  /** Plain text, capped. Empty for HTML-only emails. */
  body: string;
  /** sanitize-html output, capped. Null for outbound and text-only inbound. */
  bodyHtml: string | null;
  /** Outbound: the tenant From address. Inbound: the contact. */
  from: string;
  /** Outbound: the contact. Inbound: the capture address. */
  to: string;
  resendEmailId: string | null;
  /** RFC 5322 Message-ID, for threading. */
  messageId: string | null;
  sentByUid: string | null;
  error: string | null;
  createdAt: Timestamp | FieldValue | null;
  readAt: Timestamp | FieldValue | null;
}
