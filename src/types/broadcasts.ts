import type { Timestamp, FieldValue } from "firebase/firestore";

/**
 * Bulk email broadcasts.
 *
 *   broadcasts/{broadcastId}
 *   broadcasts/{broadcastId}/sends/{contactId}
 *
 * Each send row is one QStash step and one Resend call; row transitions bump
 * the parent totals with FieldValue.increment(). Email only: SMS needs
 * consent capture and A2P 10DLC throughput handling first.
 */

export type BroadcastChannel = "email";

export type BroadcastStatus =
  | "queued"
  /** At least one row has left "queued". */
  | "sending"
  | "completed"
  /** Hard-failed during creation (e.g. QStash misconfigured). */
  | "failed";

export type BroadcastAudienceFilter =
  | { kind: "all" }
  | { kind: "tag"; tag: string }
  | { kind: "pipeline_stage"; stage: string };

export interface BroadcastTotals {
  /** Before opt-out / missing-email skips. */
  audienceSize: number;
  queued: number;
  /** Accepted by Resend. */
  sent: number;
  skipped: number;
  failed: number;
}

export interface BroadcastDoc {
  id: string;
  agencyId: string;
  subAccountId: string;
  channel: BroadcastChannel;
  templateId: string;
  /** Snapshot; survives template renames. */
  templateName: string;
  /** Subject after merge tags, for the list view. */
  subjectPreview: string;
  audienceFilter: BroadcastAudienceFilter;
  status: BroadcastStatus;
  totals: BroadcastTotals;
  createdByUid: string;
  /** Snapshot; survives user deletion. */
  createdBy: {
    displayName: string;
    email: string;
  };
  createdAt: Timestamp | FieldValue | null;
  startedAt: Timestamp | FieldValue | null;
  completedAt: Timestamp | FieldValue | null;
  errorMessage: string | null;
}

/** Skipped without calling Resend. */
export type BroadcastSkipReason =
  | "opt_out"
  /** Usually caught by the pre-filter already. */
  | "no_email"
  /** Outside the send window; deferred and retried. */
  | "send_window_deferred"
  /** Deleted between fan-out and send. */
  | "contact_missing";

export type BroadcastSendStatus =
  | "queued"
  | "sent"
  | "skipped"
  | "failed";

export interface BroadcastSendDoc {
  id: string; // === contactId
  broadcastId: string;
  agencyId: string;
  subAccountId: string;
  contactId: string;
  /** Snapshot at fan-out time, kept for audit if the contact is deleted. */
  toEmail: string;
  toName: string;
  status: BroadcastSendStatus;
  skippedReason: BroadcastSkipReason | null;
  resendMessageId: string | null;
  error: string | null;
  /** Capped to prevent retry storms. */
  attempts: number;
  queuedAt: Timestamp | FieldValue | null;
  sentAt: Timestamp | FieldValue | null;
}
