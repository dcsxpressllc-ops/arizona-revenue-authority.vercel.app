import type { Timestamp, FieldValue } from "firebase/firestore";
import type { PipelineStage } from "./deals";

/**
 * Pipelines live at subAccounts/{id}/pipelines (member read, server write).
 *
 * "default" is reserved. Deals with no pipelineId belong to it, and until an admin
 * adds or removes a stage there is no pipelines/default doc: stages come from the
 * canonical six plus SubAccountDoc.pipelineStages overrides. The first structural
 * edit creates the doc, after which those overrides are ignored.
 */

export const DEFAULT_PIPELINE_ID = "default";

export const MAX_PIPELINES_PER_SUB_ACCOUNT = 10;
export const MAX_STAGES_PER_PIPELINE = 12;
export const MIN_STAGES_PER_PIPELINE = 2;

export interface PipelineStageDef {
  /** Slug from the label at creation. Never change it, deals store it. */
  id: string;
  label: string;
  /** Badge classes from STAGE_TONES. */
  tone: string;
  /** Every pipeline has exactly one won and one lost stage, so revenue reports and quote-accept work everywhere. */
  terminal?: "won" | "lost";
}

export interface PipelineDoc {
  /** "default" is reserved. */
  id: string;
  name: string;
  /** Array order is display order. */
  stages: PipelineStageDef[];
  /** Tab order; default always sorts first. */
  order: number;
  createdAt: Timestamp | FieldValue | null;
  updatedAt: Timestamp | FieldValue | null;
}

/** Doc-backed or the virtual default. */
export interface ResolvedPipeline {
  id: string;
  name: string;
  stages: PipelineStage[];
  order: number;
  /** Default pipeline with no doc yet. */
  virtual: boolean;
}

/** Tone palette for custom stages. Unknown stored values render as the first entry. */
export const STAGE_TONES: { id: string; label: string; tone: string }[] = [
  { id: "slate", label: "Slate", tone: "bg-slate-500/10 text-slate-700 dark:text-slate-300" },
  { id: "blue", label: "Blue", tone: "bg-blue-500/10 text-blue-700 dark:text-blue-300" },
  { id: "indigo", label: "Indigo", tone: "bg-indigo-500/10 text-indigo-700 dark:text-indigo-300" },
  { id: "violet", label: "Violet", tone: "bg-violet-500/10 text-violet-700 dark:text-violet-300" },
  { id: "fuchsia", label: "Fuchsia", tone: "bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-300" },
  { id: "amber", label: "Amber", tone: "bg-amber-500/10 text-amber-700 dark:text-amber-300" },
  { id: "orange", label: "Orange", tone: "bg-orange-500/10 text-orange-700 dark:text-orange-300" },
  { id: "teal", label: "Teal", tone: "bg-teal-500/10 text-teal-700 dark:text-teal-300" },
  { id: "cyan", label: "Cyan", tone: "bg-cyan-500/10 text-cyan-700 dark:text-cyan-300" },
  { id: "emerald", label: "Emerald", tone: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" },
  { id: "rose", label: "Rose", tone: "bg-rose-500/10 text-rose-700 dark:text-rose-300" },
];
