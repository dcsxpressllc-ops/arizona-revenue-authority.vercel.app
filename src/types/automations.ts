import type { Timestamp, FieldValue } from "firebase/firestore";

export type RecipeType = "instant_response";

/**
 * Only form_submit is exposed in the editor. Quote and booking triggers are
 * dispatched, but no recipe handles them: computeFirstStepDelay returns null,
 * so an automation using one creates an execution and sends nothing.
 */
export type AutomationTriggerType =
  | "form_submit"
  | "quote_sent"
  | "quote_accepted"
  | "quote_declined"
  | "quote_marked_paid"
  // Booking lifecycle (dispatched, no recipe handles it yet).
  | "event_booked"
  | "event_cancelled"
  | "event_rescheduled"
  | "event_paid";

export type AutomationStatus = "running" | "completed" | "stopped" | "failed";

export type StoppedReason =
  | "automation_disabled"
  | "manual"
  | "opt_out"
  | "booking";

export interface AutomationTrigger {
  type: AutomationTriggerType;
  /** Required when type === "form_submit". */
  formId: string | null;
}

/** Each step is optional; null means that channel doesn't fire. */
export interface InstantResponseConfig {
  leadSms: { templateId: string; delaySeconds: number } | null;
  leadEmail: { templateId: string; delaySeconds: number } | null;
  ownerNotify: {
    channel: "sms" | "email";
    templateId: string;
    /** Owner email or phone in E.164. */
    recipient: string;
  } | null;
}

export type RecipeConfig = InstantResponseConfig;

export interface AutomationDoc {
  id: string;
  agencyId: string;
  subAccountId: string;
  recipeType: RecipeType;
  name: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  config: RecipeConfig;
  createdByUid: string;
  createdAt: Timestamp | FieldValue | null;
  updatedAt: Timestamp | FieldValue | null;
}

export type StepChannel = "email" | "sms";

export interface ExecutionStepHistoryEntry {
  stepIndex: number;
  channel: StepChannel;
  templateId: string;
  recipient: string;
  sentAt: Timestamp | FieldValue | null;
  success: boolean;
  /** Set when success === false. */
  error?: string | null;
  /** Set when the executor short-circuited the send. */
  skippedReason?: "opt_out" | "missing_field" | "automation_disabled" | null;
}

export interface ExecutionDoc {
  id: string;
  agencyId: string;
  subAccountId: string;
  automationId: string;
  contactId: string;
  status: AutomationStatus;
  currentStepIndex: number;
  /** Null once finished. */
  nextStepDueAt: Timestamp | FieldValue | null;
  /** Last QStash messageId, kept for cancellation. */
  qstashMessageId: string | null;
  history: ExecutionStepHistoryEntry[];
  startedAt: Timestamp | FieldValue | null;
  completedAt: Timestamp | FieldValue | null;
  stoppedReason: StoppedReason | null;
}

export interface MessageTemplateDoc {
  id: string;
  agencyId: string;
  subAccountId: string;
  type: StepChannel;
  name: string;
  /** Email only; ignored on SMS templates. */
  subject: string | null;
  body: string;
  createdByUid: string;
  createdAt: Timestamp | FieldValue | null;
  updatedAt: Timestamp | FieldValue | null;
}
