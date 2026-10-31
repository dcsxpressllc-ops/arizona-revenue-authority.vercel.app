import type { Timestamp, FieldValue } from "firebase/firestore";

/**
 * Meta-approved WhatsApp templates: the only compliant way to message
 * outside the 24h session window. Submitted through Twilio's Content API;
 * Meta makes the approval call.
 *
 * Stored at `subAccounts/{id}/whatsappTemplates/{id}`, separate from
 * `message_templates` because these have an external approval lifecycle, a
 * Twilio `contentSid`, and positional variables ({{1}}, {{2}}) instead of
 * named merge tags.
 */

/** Affects pricing and review strictness. */
export type WhatsappTemplateCategory =
  | "UTILITY"
  | "MARKETING"
  | "AUTHENTICATION";

/**
 * `pending` = waiting on Meta (Twilio "received" and "pending" both map
 * here). `paused`/`disabled` are applied by Meta after approval. `failed`
 * means the Twilio submission itself errored, not a Meta rejection.
 */
export type WhatsappTemplateStatus =
  | "draft"
  | "submitting"
  | "pending"
  | "approved"
  | "rejected"
  | "paused"
  | "disabled"
  | "failed";

export type WhatsappVariableSource = "merge_tag" | "manual";

/**
 * A positional variable. `merge_tag` resolves from the contact at send time
 * (and is the only kind usable without a human in the loop); `manual` is
 * typed by the operator when sending. Meta requires a realistic sampleValue.
 */
export interface WhatsappTemplateVariable {
  /** 1-indexed, matches {{n}} in `body`. */
  position: number;
  label: string;
  /** Submitted to Meta for review. */
  sampleValue: string;
  source: WhatsappVariableSource;
  /** Set for merge_tag (validated against the allow-list), null for manual. */
  mergeTag: string | null;
}

export interface WhatsappTemplateDoc {
  id: string;
  subAccountId: string;
  agencyId: string;
  /** Meta name: lowercase + underscores, unique per WABA. Derived from displayName if unset. */
  name: string;
  displayName: string;
  category: WhatsappTemplateCategory;
  /** e.g. "en", "en_US". */
  language: string;
  /** Uses positional {{1}} placeholders. */
  body: string;
  variables: WhatsappTemplateVariable[];
  /** Twilio Content id (HX...). Null until submitted; the send path and approval poll use it. */
  contentSid: string | null;
  status: WhatsappTemplateStatus;
  /** Meta's reason when rejected, or the Twilio error when failed. */
  rejectionReason: string | null;
  /** QStash approval-poll bookkeeping. */
  pollAttempts: number;
  lastSyncedAt: Timestamp | FieldValue | null;
  createdByUid: string;
  createdAt: Timestamp | FieldValue | null;
  updatedAt: Timestamp | FieldValue | null;
  approvedAt: Timestamp | FieldValue | null;
}

/** Allowed merge tags for template variables (automation tags minus unsubscribeLink). */
export const WHATSAPP_VARIABLE_MERGE_TAGS: ReadonlyArray<{
  tag: string;
  description: string;
}> = [
  { tag: "contact.firstName", description: "Contact's first name" },
  { tag: "contact.lastName", description: "Contact's last name" },
  { tag: "contact.email", description: "Contact's email address" },
  { tag: "contact.phone", description: "Contact's phone number" },
  { tag: "owner.firstName", description: "Agency owner's first name" },
  { tag: "workspace.name", description: "Sub-account / business name" },
  { tag: "bookingLink", description: "Booking page URL" },
];

export function isWhatsappMergeTag(tag: string): boolean {
  return WHATSAPP_VARIABLE_MERGE_TAGS.some((t) => t.tag === tag);
}
