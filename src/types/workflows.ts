import type { Timestamp, FieldValue } from "firebase/firestore";

/**
 * A workflow is a trigger plus a graph of nodes (linear, with if/else
 * branches). A run is one contact's enrollment, advanced node by node by the
 * QStash step worker.
 */

export type WorkflowStatus = "draft" | "active" | "paused";

/**
 * Re-enrollment policy, checked at trigger time. Absent = "every_time".
 * "unless_active" skips contacts with a running/waiting run; "once_ever"
 * enrolls each contact at most once. Test enrollments bypass it.
 */
export type WorkflowReentry = "every_time" | "unless_active" | "once_ever";

export type WorkflowTriggerType =
  | "contact.created"
  | "contact.tag.added"
  | "form.submitted"
  | "pipeline.stage.changed"
  | "booking.created"
  | "booking.cancelled"
  | "booking.rescheduled"
  | "quote.accepted"
  | "quote.paid"
  | "message.received"
  // Card payment confirmed by the sub-account's own Stripe. quote.paid covers
  // the manual mark-paid path. Fired from lib/server/orders-service.ts.
  | "order.paid"
  // Broadcast engagement, fired on the FIRST open / click per recipient so a
  // contact can't enrol once per open. Fired from lib/comms/email-events.ts.
  | "email.opened"
  | "email.clicked";

export type ConditionOp =
  | "equals"
  | "not_equals"
  | "contains"
  | "is_set"
  | "not_set"
  | "has_tag"
  | "in_stage"
  | "source_is";

export interface Condition {
  /** Contact field path (e.g. "email", "company", "customFields.x"). */
  field: string;
  op: ConditionOp;
  value?: string;
}

/** Flat condition list. `match` absent = "all" (AND); "any" = OR. */
export interface ConditionGroup {
  all: Condition[];
  match?: "all" | "any";
}

export interface WorkflowTrigger {
  type: WorkflowTriggerType;
  filters: ConditionGroup;
  /** Restrict `form.submitted` to one form. Null/absent = any form. */
  formId?: string | null;
  /** Restrict `pipeline.stage.changed` to one target stage. */
  toStage?: string | null;
  /** Pipeline that `toStage` belongs to. Null/absent = the default pipeline. */
  toPipeline?: string | null;
  /** Restrict `message.received` to one channel (sms | whatsapp | messenger | instagram). Null = any. */
  channel?: string | null;
  /** Restrict `email.opened` / `email.clicked` to one broadcast. Null/absent = any broadcast. */
  broadcastId?: string | null;
}

export type WorkflowNodeType =
  | "send_email"
  | "send_sms"
  | "send_ai_sms"
  | "whatsapp_template"
  | "wait"
  | "wait_for_reply"
  | "if_else"
  | "goal"
  | "add_tag"
  | "remove_tag"
  | "move_stage"
  | "update_field"
  | "create_task"
  | "notify"
  | "webhook";

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  /** Validated per type at execution. */
  config: Record<string, unknown>;
  /** Null/absent ends the run. */
  next?: string | null;
  /**
   * if_else: whenTrue = conditions pass. wait_for_reply: whenTrue = replied,
   * whenFalse = timed out.
   */
  branches?: { whenTrue: string | null; whenFalse: string | null };
}

export interface WorkflowDoc {
  id: string;
  subAccountId: string;
  agencyId: string;
  createdByUid: string;
  name: string;
  status: WorkflowStatus;
  trigger: WorkflowTrigger;
  /** Absent = "every_time". */
  reentry?: WorkflowReentry;
  /** Null = empty workflow (won't enroll). */
  startNodeId: string | null;
  nodes: Record<string, WorkflowNode>;
  stats: { enrolled: number; completed: number };
  createdAt: Timestamp | FieldValue | null;
  updatedAt: Timestamp | FieldValue | null;
}

export type WorkflowRunStatus =
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "exited";

export interface WorkflowRunHistoryEntry {
  nodeId: string;
  type: WorkflowNodeType;
  at: Timestamp | FieldValue | null;
  /** "ok" | "skipped:<reason>" | "error:<msg>" | "branch:true|false" | "replied:<channel>" | "timeout" */
  result: string;
}

/**
 * Set while a run is parked on wait_for_reply. The inbound-message hook
 * resolves it early, the QStash timeout late. Both claim the node in a
 * transaction so exactly one wins; the winner's history entry makes the
 * loser a no-op via the step worker's idempotency guard.
 */
export interface WorkflowRunWaiting {
  nodeId: string;
  kind: "reply";
  since: Timestamp | FieldValue | null;
  until: Timestamp | FieldValue | null;
}

export interface WorkflowRunDoc {
  id: string;
  subAccountId: string;
  agencyId: string;
  workflowId: string;
  contactId: string;
  status: WorkflowRunStatus;
  currentNodeId: string | null;
  waiting?: WorkflowRunWaiting | null;
  history: WorkflowRunHistoryEntry[];
  /** Trigger payload snapshot (e.g. { formId, dealId }). */
  context: Record<string, unknown>;
  qstashMessageId: string | null;
  /** Retries per node, capped so a step can't defer forever. */
  retryCounts?: Record<string, number>;
  /** Why the run is waiting on a deferred step, shown in Runs. */
  deferNote?: string | null;
  enrolledAt: Timestamp | FieldValue | null;
  updatedAt: Timestamp | FieldValue | null;
}

// Typed views of node config.

export interface SendEmailConfig {
  subject: string;
  body: string;
}
export interface SendSmsConfig {
  body: string;
}
/** The AI writes the text from the agent persona, KB and contact details. */
export interface SendAiSmsConfig {
  /** What the opener should achieve, e.g. "ask when suits for a quote call". */
  instruction: string;
  /** Adds "Reply STOP to opt out." Absent reads as true. */
  appendOptOut?: boolean;
}
export interface WhatsappTemplateConfig {
  /** Doc id under subAccounts/{id}/whatsappTemplates. */
  templateId: string;
  /**
   * Values for the template's manual variables, keyed by position. May hold
   * merge tags (resolved at run time). merge_tag variables aren't stored here.
   */
  manualValues?: Record<string, string>;
}
export interface WaitConfig {
  seconds: number;
}
/** Timeout window for wait_for_reply. */
export interface WaitForReplyConfig {
  seconds: number;
}
export interface IfElseConfig {
  conditions: ConditionGroup;
}
export interface TagConfig {
  tag: string;
}
export interface MoveStageConfig {
  stage: string;
}
export interface UpdateFieldConfig {
  field: string;
  value: string;
}
export interface CreateTaskConfig {
  title: string;
  dueInDays?: number;
}
/** Missing on older configs; the engine treats that as "custom" (use `to`, else the agency owner). */
export type NotifyRecipient = "owner" | "account_contact" | "custom";

export interface NotifyConfig {
  recipient?: NotifyRecipient;
  /** Only used when `recipient` is "custom" or absent. */
  to: string;
  subject: string;
  body: string;
}
export interface WebhookConfig {
  url: string;
}
