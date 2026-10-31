import type { Timestamp, FieldValue } from "firebase/firestore";

/** The six built-in stage ids of the default pipeline. Custom pipelines mint their own. */
export type CanonicalStageId =
  | "new"
  | "contacted"
  | "qualified"
  | "proposal"
  | "won"
  | "lost";

/** Any slug. Only meaningful within a pipeline; the deal's `pipelineId` scopes it. */
export type PipelineStageId = string;

export interface PipelineStage {
  id: PipelineStageId;
  label: string;
  tone: string;
  terminal?: "won" | "lost";
}

export const PIPELINE_STAGES: PipelineStage[] = [
  { id: "new", label: "New", tone: "bg-slate-500/10 text-slate-700 dark:text-slate-300" },
  { id: "contacted", label: "Contacted", tone: "bg-blue-500/10 text-blue-700 dark:text-blue-300" },
  { id: "qualified", label: "Qualified", tone: "bg-indigo-500/10 text-indigo-700 dark:text-indigo-300" },
  { id: "proposal", label: "Proposal", tone: "bg-amber-500/10 text-amber-700 dark:text-amber-300" },
  { id: "won", label: "Won", tone: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300", terminal: "won" },
  { id: "lost", label: "Lost", tone: "bg-rose-500/10 text-rose-700 dark:text-rose-300", terminal: "lost" },
];

/** Pass a resolved stage list to get overridden labels; defaults to the canonical stages. */
export function getStage(
  id: PipelineStageId | string | null | undefined,
  stages: PipelineStage[] = PIPELINE_STAGES,
): PipelineStage {
  return stages.find((s) => s.id === id) ?? stages[0] ?? PIPELINE_STAGES[0];
}

/**
 * Display override for a canonical stage. Only label and order are editable;
 * id and terminal stay canonical so a rename can't change stored stageIds or
 * drop the won/lost terminals.
 */
export interface PipelineStageOverride {
  id: CanonicalStageId;
  label: string;
  order: number;
}

/** Applies label/order overrides. Missing or invalid overrides return the canonical list. */
export function resolvePipelineStages(
  overrides?: PipelineStageOverride[] | null,
): PipelineStage[] {
  if (!Array.isArray(overrides) || overrides.length === 0) {
    return PIPELINE_STAGES;
  }
  const byId = new Map<string, PipelineStageOverride>(
    overrides.map((o) => [o.id, o]),
  );
  const withOrder = PIPELINE_STAGES.map((s, idx) => {
    const o = byId.get(s.id);
    const label =
      o && typeof o.label === "string" && o.label.trim().length > 0
        ? o.label
        : s.label;
    const order =
      o && typeof o.order === "number" && Number.isFinite(o.order)
        ? o.order
        : idx;
    // id, tone, terminal are never taken from the override.
    return { stage: { ...s, label } as PipelineStage, order, idx };
  });
  withOrder.sort((a, b) => a.order - b.order || a.idx - b.idx);
  return withOrder.map((x) => x.stage);
}

export type DealPriority = "high" | "medium" | "low";

export interface DealPriorityOption {
  id: DealPriority;
  label: string;
  badge: string;
}

export const DEAL_PRIORITIES: DealPriorityOption[] = [
  {
    id: "high",
    label: "High",
    badge: "bg-rose-500/15 text-rose-700 ring-1 ring-rose-500/30 dark:text-rose-300",
  },
  {
    id: "medium",
    label: "Medium",
    badge: "bg-amber-500/15 text-amber-700 ring-1 ring-amber-500/30 dark:text-amber-300",
  },
  {
    id: "low",
    label: "Low",
    badge: "bg-emerald-500/15 text-emerald-700 ring-1 ring-emerald-500/30 dark:text-emerald-300",
  },
];

export function getPriority(
  id: DealPriority | string | null | undefined,
): DealPriorityOption {
  return (
    DEAL_PRIORITIES.find((p) => p.id === id) ??
    DEAL_PRIORITIES[1]
  );
}

export interface Deal {
  id: string;
  title: string;
  value: number;
  currency: string;
  contactId: string;
  /** Null/absent = the default pipeline (older deals never had the field). Use `dealPipelineId()`. */
  pipelineId?: string | null;
  stageId: PipelineStageId;
  priority: DealPriority;
  agencyId: string;
  subAccountId: string;
  createdByUid: string;
  lostReason: string | null;
  /** Ticked on a Won card when the work is delivered (separate from Won).
   *  Drives the review-request trigger `triggerOnDealCompleted`. */
  completed?: boolean;
  completedAt?: Timestamp | FieldValue | null;
  /** Keyed by CustomFieldDef.key; validated server-side against the deal field defs. */
  customFields?: Record<string, import("./custom-fields").CustomFieldValue> | null;
  /** Defaults to "global"; null/absent is treated as global. Ignored unless territory scoping is on. */
  territoryId?: string | null;
  createdAt: Timestamp | FieldValue | null;
  updatedAt: Timestamp | FieldValue | null;
  stageChangedAt: Timestamp | FieldValue | null;
}

export type DealFormData = {
  title: string;
  value: number;
  currency: string;
  contactId: string;
  /** Absent/null = default pipeline (see {@link Deal.pipelineId}). */
  pipelineId?: string | null;
  stageId: PipelineStageId;
  priority: DealPriority;
  territoryId?: string | null;
  customFields?: Record<string, import("./custom-fields").CustomFieldValue> | null;
};
