import type { Timestamp, FieldValue } from "firebase/firestore";
import type { BroadcastAudienceFilter } from "./broadcasts";

/**
 * Bulk outbound AI voice campaigns.
 *
 *   voiceCampaigns/{campaignId}
 *   voiceCampaigns/{campaignId}/recipients/{contactId}
 *
 * Same shape as bulk-email broadcasts: each recipient row is one QStash step
 * (compliance gate, then a Vapi call, skip or deferral), and row transitions
 * bump the parent totals with FieldValue.increment().
 */

export type VoiceCampaignStatus =
  | "queued"
  /** At least one row has left "queued". */
  | "calling"
  | "completed"
  /** Stopped by the operator; no further calls. */
  | "cancelled"
  /** Hard-failed during creation (e.g. QStash misconfigured). */
  | "failed";

export interface VoiceCampaignTotals {
  /** Before pre-flight skips. */
  audienceSize: number;
  /** Includes rows deferred to the calling window. */
  queued: number;
  called: number;
  /** Blocked by the compliance gate; no call placed. */
  skipped: number;
  /** Vapi errored placing the call. */
  failed: number;
  /** Called recipients the AI flagged as interested. */
  interested: number;
}

/** Conversation outcome, set by the end-of-call handler. Separate from the queue `status`. */
export type VoiceCampaignOutcome =
  | "interested"
  | "not_interested"
  | "callback"
  | "no_answer"
  | "voicemail"
  | "completed"
  | "failed";

/** Suppression chosen at launch, kept for the audit trail. Null = off. */
export interface VoiceCampaignSuppression {
  /** Skip contacts called by any campaign in the last N days. */
  recentDays: number | null;
  excludeCampaignId: string | null;
  excludeTag: string | null;
}

export interface VoiceCampaignDoc {
  id: string;
  agencyId: string;
  subAccountId: string;
  /** "VC-YYYY-NNNN", per sub-account. */
  code: string;
  name: string;
  suppression: VoiceCampaignSuppression;
  audienceFilter: BroadcastAudienceFilter;
  /** Snapshot of the opener used. */
  openerPreview: string;
  status: VoiceCampaignStatus;
  totals: VoiceCampaignTotals;
  /** Operator affirmed consent for the whole batch; passed to the per-call gate. */
  consentAck: boolean;
  createdByUid: string;
  createdBy: { displayName: string; email: string };
  createdAt: Timestamp | FieldValue | null;
  startedAt: Timestamp | FieldValue | null;
  completedAt: Timestamp | FieldValue | null;
  errorMessage: string | null;
}

/**
 * Compliance-gate codes plus fan-out/housekeeping reasons.
 * `window_unreached` = deferred to the calling window too many times.
 */
export type VoiceCampaignSkipReason =
  | "opted_out"
  | "no_phone"
  | "country_blocked"
  | "daily_cap"
  | "number_frequency"
  | "scrub_blocked"
  | "window_unreached"
  | "contact_missing"
  | "cancelled"
  // Fan-out suppression:
  | "recently_called"
  | "suppressed_tag"
  | "prior_campaign";

export type VoiceCampaignRecipientStatus =
  | "queued"
  | "called"
  | "skipped"
  | "failed";

export interface VoiceCampaignRecipientDoc {
  id: string; // === contactId
  campaignId: string;
  agencyId: string;
  subAccountId: string;
  contactId: string;
  /** Snapshot at fan-out time. */
  toPhone: string;
  toName: string;
  status: VoiceCampaignRecipientStatus;
  skippedReason: VoiceCampaignSkipReason | null;
  callId: string | null;
  /** Vapi monitor.controlUrl; the stop-all switch uses it to end a live call. */
  callControlUrl: string | null;
  // outcome, callDurationSec, endedReason and callSummary are set by the end-of-call handler.
  outcome: VoiceCampaignOutcome | null;
  callDurationSec: number | null;
  /** Vapi end state, e.g. "customer-did-not-answer". */
  endedReason: string | null;
  callSummary: string | null;
  /** Follow-up Task created when flagged interested. */
  taskId: string | null;
  /** Set when status is "failed". */
  error: string | null;
  /** Step attempts incl. window/rate deferrals; capped to stop reschedule loops. */
  attempts: number;
  queuedAt: Timestamp | FieldValue | null;
  settledAt: Timestamp | FieldValue | null;
}
