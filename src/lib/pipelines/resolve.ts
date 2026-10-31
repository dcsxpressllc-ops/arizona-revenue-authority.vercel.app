import {
  PIPELINE_STAGES,
  resolvePipelineStages,
  type Deal,
  type PipelineStage,
  type PipelineStageOverride,
} from "@/types/deals";
import {
  DEFAULT_PIPELINE_ID,
  MAX_STAGES_PER_PIPELINE,
  MIN_STAGES_PER_PIPELINE,
  STAGE_TONES,
  type PipelineDoc,
  type PipelineStageDef,
  type ResolvedPipeline,
} from "@/types/pipelines";

/**
 * Client-safe pipeline resolution and validation (no "server-only"; the
 * settings manager, board and workflow builder run it in the browser).
 *
 * The rule everything relies on: a deal without `pipelineId` is on the
 * default pipeline, and a sub-account without a `pipelines/default` doc gets
 * a virtual default built from the canonical six stages plus the old
 * rename/reorder overrides.
 */

export function dealPipelineId(
  deal: Pick<Deal, "pipelineId"> | { pipelineId?: string | null },
): string {
  const id = deal.pipelineId;
  return typeof id === "string" && id.length > 0 ? id : DEFAULT_PIPELINE_ID;
}

/** Virtual default from the legacy override field. */
export function virtualDefaultPipeline(
  legacyOverrides?: PipelineStageOverride[] | null,
): ResolvedPipeline {
  return {
    id: DEFAULT_PIPELINE_ID,
    name: "Pipeline",
    stages: resolvePipelineStages(legacyOverrides),
    order: -1, // default always sorts first
    virtual: true,
  };
}

function stageDefsToStages(defs: PipelineStageDef[]): PipelineStage[] {
  return defs.map((d) => ({
    id: d.id,
    label: d.label,
    tone: d.tone || STAGE_TONES[0].tone,
    ...(d.terminal ? { terminal: d.terminal } : {}),
  }));
}

/**
 * Pipeline docs merged with the virtual default, default first then by
 * `order`. A real `pipelines/default` doc replaces the virtual one, and the
 * legacy override field is ignored from then on.
 */
export function resolvePipelineList(input: {
  docs: PipelineDoc[];
  legacyOverrides?: PipelineStageOverride[] | null;
}): ResolvedPipeline[] {
  const out: ResolvedPipeline[] = [];
  const defaultDoc = input.docs.find((d) => d.id === DEFAULT_PIPELINE_ID);
  out.push(
    defaultDoc
      ? {
          id: DEFAULT_PIPELINE_ID,
          name: defaultDoc.name || "Pipeline",
          stages: stageDefsToStages(defaultDoc.stages),
          order: -1,
          virtual: false,
        }
      : virtualDefaultPipeline(input.legacyOverrides),
  );
  const rest = input.docs
    .filter((d) => d.id !== DEFAULT_PIPELINE_ID)
    .map((d) => ({
      id: d.id,
      name: d.name || "Pipeline",
      stages: stageDefsToStages(d.stages),
      order: typeof d.order === "number" ? d.order : 0,
      virtual: false,
    }))
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  out.push(...rest);
  return out;
}

/** Unknown ids fall back to the default so a deal whose pipeline was deleted still renders. */
export function getPipeline(
  pipelines: ResolvedPipeline[],
  pipelineId: string | null | undefined,
): ResolvedPipeline {
  const id =
    typeof pipelineId === "string" && pipelineId.length > 0
      ? pipelineId
      : DEFAULT_PIPELINE_ID;
  return (
    pipelines.find((p) => p.id === id) ??
    pipelines.find((p) => p.id === DEFAULT_PIPELINE_ID) ??
    virtualDefaultPipeline(null)
  );
}

/** Validator guarantees one exists. */
export function wonStageId(pipeline: ResolvedPipeline): string {
  return pipeline.stages.find((s) => s.terminal === "won")?.id ?? "won";
}

export function lostStageId(pipeline: ResolvedPipeline): string {
  return pipeline.stages.find((s) => s.terminal === "lost")?.id ?? "lost";
}

// Slugs + validation (manage routes, settings UI, GHL import)

/** "Follow up!" -> "follow-up". Empty input gets the fallback. */
export function slugify(label: string, fallback = "stage"): string {
  const slug = label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || fallback;
}

/** Unique within `taken` by suffixing -2, -3, ... */
export function uniqueSlug(label: string, taken: Set<string>, fallback = "stage"): string {
  const base = slugify(label, fallback);
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

export interface PipelineValidationInput {
  name: unknown;
  stages: unknown;
}

/**
 * Returns normalized fields or a readable error. 2-12 stages, exactly one won
 * and one lost terminal, unique ids and labels.
 */
export function validatePipelineShape(input: PipelineValidationInput):
  | { ok: true; name: string; stages: PipelineStageDef[] }
  | { ok: false; error: string } {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name.length === 0 || name.length > 40) {
    return { ok: false, error: "Pipeline name must be 1–40 characters." };
  }
  if (!Array.isArray(input.stages)) {
    return { ok: false, error: "Stages must be a list." };
  }
  const raw = input.stages as Array<Record<string, unknown>>;
  if (
    raw.length < MIN_STAGES_PER_PIPELINE ||
    raw.length > MAX_STAGES_PER_PIPELINE
  ) {
    return {
      ok: false,
      error: `A pipeline needs ${MIN_STAGES_PER_PIPELINE}–${MAX_STAGES_PER_PIPELINE} stages.`,
    };
  }
  const stages: PipelineStageDef[] = [];
  const ids = new Set<string>();
  const labels = new Set<string>();
  let won = 0;
  let lost = 0;
  for (const s of raw) {
    const label = typeof s.label === "string" ? s.label.trim() : "";
    if (label.length === 0 || label.length > 30) {
      return { ok: false, error: "Every stage needs a 1–30 character name." };
    }
    const labelKey = label.toLowerCase();
    if (labels.has(labelKey)) {
      return { ok: false, error: `Duplicate stage name: "${label}".` };
    }
    labels.add(labelKey);
    const id =
      typeof s.id === "string" && s.id.length > 0
        ? s.id
        : uniqueSlug(label, ids);
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) {
      return { ok: false, error: `Invalid stage id "${id}".` };
    }
    if (ids.has(id)) {
      return { ok: false, error: `Duplicate stage id: "${id}".` };
    }
    ids.add(id);
    const terminal =
      s.terminal === "won" || s.terminal === "lost" ? s.terminal : undefined;
    if (terminal === "won") won++;
    if (terminal === "lost") lost++;
    const tone =
      typeof s.tone === "string" && s.tone.length > 0
        ? s.tone
        : STAGE_TONES[0].tone;
    stages.push({ id, label, tone, ...(terminal ? { terminal } : {}) });
  }
  if (won !== 1 || lost !== 1) {
    return {
      ok: false,
      error:
        "Every pipeline needs exactly one Won stage and one Lost stage (rename them freely — they anchor revenue reporting).",
    };
  }
  return { ok: true, name, stages };
}

/** Default stages as they resolve now (canonical + overrides); what materializing copies into `pipelines/default`. */
export function materializedDefaultStages(
  legacyOverrides?: PipelineStageOverride[] | null,
): PipelineStageDef[] {
  return resolvePipelineStages(legacyOverrides).map((s) => ({
    id: s.id,
    label: s.label,
    tone: s.tone,
    ...(s.terminal ? { terminal: s.terminal } : {}),
  }));
}

/** Canonical defs, the template for brand-new pipelines. */
export function canonicalStageDefs(): PipelineStageDef[] {
  return PIPELINE_STAGES.map((s) => ({
    id: s.id,
    label: s.label,
    tone: s.tone,
    ...(s.terminal ? { terminal: s.terminal } : {}),
  }));
}
