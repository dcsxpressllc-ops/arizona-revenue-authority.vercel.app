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
  | { kind: "pipeline_stage"; stage: string }
  /** Delivered-but-unopened recipients of an earlier broadcast (resend to unopened). */
  | { kind: "broadcast_unopened"; broadcastId: string };

export interface BroadcastTotals {
  /** Before opt-out / missing-email skips. */
  audienceSize: number;
  queued: number;
  /** Accepted by Resend. */
  sent: number;
  skipped: number;
  failed: number;
  // Engagement from Resend webhooks; absent on older docs = 0. Each counts
  // recipients once (first occurrence), not events.
  delivered?: number;
  opened?: number;
  clicked?: number;
  bounced?: number;
  complained?: number;
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
  /** Set when this broadcast is a "resend to unopened" of another one. */
  resendOfBroadcastId?: string | null;
}

/** Skipped without calling Resend. */
export type BroadcastSkipReason =
  | "opt_out"
  /** Usually caught by the pre-filter already. */
  | "no_email"
  /** A previous send hard-bounced; skipped until a later delivery clears it. */
  | "bounced"
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
  // Engagement from Resend webhooks (absent until the event arrives).
  deliveredAt?: Timestamp | FieldValue | null;
  /** First open. */
  openedAt?: Timestamp | FieldValue | null;
  /** First click. */
  clickedAt?: Timestamp | FieldValue | null;
  opens?: number;
  clicks?: number;
  bouncedAt?: Timestamp | FieldValue | null;
  bounceReason?: string | null;
  complainedAt?: Timestamp | FieldValue | null;
}

/**
 * Server-only lookup written when a tracked email is sent, so a Resend
 * delivery event (keyed by email_id) resolves to its row in one read.
 * Swept after `expiresAt` by the daily cleanup cron.
 */
export interface EmailEventLookupDoc {
  kind: "broadcast";
  broadcastId: string;
  contactId: string;
  subAccountId: string;
  agencyId: string;
  sentAt: Timestamp | FieldValue | null;
  expiresAt: Timestamp | FieldValue | Date;
}
