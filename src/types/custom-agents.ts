import type { Timestamp, FieldValue } from "firebase/firestore";

/**
 * Inbox follow-up watchdog (Labs). One doc per sub-account at customAgents/{subAccountId},
 * top-level so the hourly sweep is a plain where("enabled") query with no
 * collection-group index. Server-only; runs log under customAgents/{said}/runs.
 */

export interface WatchdogQuietHours {
  /** Local hour 0-23. */
  startHour: number;
  /** Local hour 0-23. Overnight windows (22 to 7) work. */
  endHour: number;
  /** IANA zone. */
  timezone: string;
}

export interface WatchdogConfigDoc {
  /** Same as the doc id. */
  subAccountId: string;
  agencyId: string;
  /** Off by default; admin opts in. */
  enabled: boolean;
  /** Hours an inbound conversation can sit unanswered before judging (1-24). */
  thresholdHours: number;
  /** Extra criteria passed verbatim to the judge, max 1000 chars. */
  instructions: string | null;
  /** Suppresses push only; the task is still created. */
  quietHours: WatchdogQuietHours | null;
  /** Per UTC day. Runs skip once exceeded. */
  dailyTokenBudget: number;
  /** UTC YYYY-MM-DD that tokensToday counts for. */
  tokensTodayDate: string | null;
  tokensToday: number;
  totalTokensUsed: number;
  createdAt: Timestamp | FieldValue | Date | null;
  updatedAt: Timestamp | FieldValue | Date | null;
}

export const WATCHDOG_DEFAULT_THRESHOLD_HOURS = 3;
export const WATCHDOG_DEFAULT_DAILY_TOKEN_BUDGET = 20_000;
/** Max LLM judgments per sweep run (cost ceiling). */
export const WATCHDOG_MAX_JUDGMENTS_PER_RUN = 20;

export type WatchdogRunStatus = "completed" | "skipped" | "failed";

export type WatchdogSkippedReason =
  | "labs_gate_off"
  | "ai_gate_off"
  | "ai_not_configured"
  | "budget_exceeded";

export interface WatchdogRunAction {
  contactId: string;
  contactName: string;
  taskId: string;
  /** Max 140 chars. */
  reason: string;
  urgency: "high" | "normal";
}

export interface WatchdogRunDoc {
  status: WatchdogRunStatus;
  skippedReason: WatchdogSkippedReason | null;
  /** Matched the pre-filter. */
  scanned: number;
  /** Dropped by WATCHDOG_MAX_JUDGMENTS_PER_RUN. */
  droppedByCap: number;
  /** LLM calls made. */
  judged: number;
  flagged: number;
  actions: WatchdogRunAction[];
  tokensUsed: number;
  error: string | null;
  startedAt: Timestamp | FieldValue | Date | null;
  finishedAt: Timestamp | FieldValue | Date | null;
}

/** Config API wire shapes; timestamps are ISO strings. */
export interface WatchdogConfigResponse {
  enabled: boolean;
  thresholdHours: number;
  instructions: string | null;
  quietHours: WatchdogQuietHours | null;
  dailyTokenBudget: number;
  totalTokensUsed: number;
}

export interface WatchdogRunResponse {
  id: string;
  status: WatchdogRunStatus;
  skippedReason: WatchdogSkippedReason | null;
  scanned: number;
  judged: number;
  flagged: number;
  actions: WatchdogRunAction[];
  tokensUsed: number;
  startedAt: string | null;
  finishedAt: string | null;
}
