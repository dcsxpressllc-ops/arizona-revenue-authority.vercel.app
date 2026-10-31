import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  dealPipelineId,
  getPipeline,
  materializedDefaultStages,
  resolvePipelineList,
  slugify,
  uniqueSlug,
  validatePipelineShape,
  wonStageId,
} from "@/lib/pipelines/resolve";
import {
  DEFAULT_PIPELINE_ID,
  MAX_PIPELINES_PER_SUB_ACCOUNT,
  type PipelineDoc,
  type PipelineStageDef,
  type ResolvedPipeline,
} from "@/types/pipelines";
import type { Deal } from "@/types/deals";
import type { SubAccountDoc } from "@/types";

/**
 * Server-side pipeline loading and mutation. Routes, quote lifecycle, workflow
 * engine, public API, AI capabilities and the GHL importer all resolve through
 * here so the virtual-default rule can't drift.
 */

export class PipelineError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "PipelineError";
    this.status = status;
  }
}

function pipelinesCol(subAccountId: string) {
  return getAdminDb().collection(`subAccounts/${subAccountId}/pipelines`);
}

/** Docs plus the virtual default. */
export async function loadResolvedPipelines(
  subAccountId: string,
  /** Pass it if you already have it to save a read. */
  sub?: SubAccountDoc | null,
): Promise<ResolvedPipeline[]> {
  const db = getAdminDb();
  const [docsSnap, subSnap] = await Promise.all([
    pipelinesCol(subAccountId).get(),
    sub === undefined ? db.doc(`subAccounts/${subAccountId}`).get() : null,
  ]);
  const subDoc =
    sub !== undefined
      ? sub
      : subSnap?.exists
        ? (subSnap.data() as SubAccountDoc)
        : null;
  return resolvePipelineList({
    docs: docsSnap.docs.map((d) => ({
      ...(d.data() as PipelineDoc),
      id: d.id,
    })),
    legacyOverrides: subDoc?.pipelineStages,
  });
}

/** Unknown id falls back to default. */
export async function loadPipeline(
  subAccountId: string,
  pipelineId: string | null | undefined,
  sub?: SubAccountDoc | null,
): Promise<ResolvedPipeline> {
  return getPipeline(await loadResolvedPipelines(subAccountId, sub), pipelineId);
}

export async function wonStageIdForDeal(
  subAccountId: string,
  deal: Pick<Deal, "pipelineId">,
): Promise<string> {
  return wonStageId(await loadPipeline(subAccountId, dealPipelineId(deal)));
}

/** Throws PipelineError(400) unless `stageId` is in the deal's target pipeline. */
export async function assertStageInPipeline(
  subAccountId: string,
  pipelineId: string | null | undefined,
  stageId: string,
): Promise<ResolvedPipeline> {
  const pipeline = await loadPipeline(subAccountId, pipelineId);
  if (!pipeline.stages.some((s) => s.id === stageId)) {
    throw new PipelineError(
      `Stage "${stageId}" doesn't exist in the "${pipeline.name}" pipeline.`,
      400,
    );
  }
  return pipeline;
}


export async function createPipeline(
  subAccountId: string,
  input: { name: unknown; stages: unknown },
): Promise<PipelineDoc> {
  const valid = validatePipelineShape(input);
  if (!valid.ok) throw new PipelineError(valid.error);

  const col = pipelinesCol(subAccountId);
  const existing = await col.get();
  // The cap is about total pipelines, so count the default whether it's a doc
  // or still virtual.
  const hasDefaultDoc = existing.docs.some((d) => d.id === DEFAULT_PIPELINE_ID);
  const total = existing.size + (hasDefaultDoc ? 0 : 1);
  if (total >= MAX_PIPELINES_PER_SUB_ACCOUNT) {
    throw new PipelineError(
      `Pipeline limit reached (${MAX_PIPELINES_PER_SUB_ACCOUNT}).`,
      409,
    );
  }
  const taken = new Set(existing.docs.map((d) => d.id));
  taken.add(DEFAULT_PIPELINE_ID);
  const id = uniqueSlug(valid.name, taken, "pipeline");
  const maxOrder = existing.docs.reduce((m, d) => {
    const o = (d.data() as PipelineDoc).order;
    return typeof o === "number" && o > m ? o : m;
  }, 0);
  const doc: Omit<PipelineDoc, "createdAt" | "updatedAt"> = {
    id,
    name: valid.name,
    stages: valid.stages,
    order: maxOrder + 1,
  };
  await col.doc(id).set({
    ...doc,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return { ...doc, createdAt: null, updatedAt: null };
}

/**
 * Deals in the given stages. The default pipeline also needs an in-memory
 * pipelineId filter: older deals lack the field and Firestore can't query
 * for a missing field.
 */
async function dealsInStages(
  subAccountId: string,
  pipelineId: string,
  stageIds: string[],
): Promise<FirebaseFirestore.QueryDocumentSnapshot[]> {
  if (stageIds.length === 0) return [];
  const db = getAdminDb();
  const out: FirebaseFirestore.QueryDocumentSnapshot[] = [];
  for (const stageId of stageIds) {
    const snap = await db
      .collection("deals")
      .where("subAccountId", "==", subAccountId)
      .where("stageId", "==", stageId)
      .get();
    for (const d of snap.docs) {
      if (dealPipelineId(d.data() as Deal) === pipelineId) out.push(d);
    }
  }
  return out;
}

/**
 * Update a pipeline's name and/or stages.
 *
 * Editing "default" with no doc yet materializes the resolved stages first.
 * Removed stages need their deals moved: `moveDealsTo` (a stage in the new
 * list) names the destination, otherwise occupied removals throw 409 with
 * per-stage counts so the UI can prompt.
 *
 * Bulk moves skip per-deal stage-change side effects (restructuring isn't N
 * sales events), but `stageChangedAt` is still stamped.
 */
export async function updatePipeline(
  subAccountId: string,
  pipelineId: string,
  input: { name?: unknown; stages?: unknown; order?: unknown; moveDealsTo?: unknown },
): Promise<void> {
  const db = getAdminDb();
  const col = pipelinesCol(subAccountId);
  const ref = col.doc(pipelineId);
  const snap = await ref.get();

  let current: PipelineDoc | null = snap.exists
    ? ({ ...(snap.data() as PipelineDoc), id: pipelineId } as PipelineDoc)
    : null;

  // Virtual default: materialize before editing.
  if (!current) {
    if (pipelineId !== DEFAULT_PIPELINE_ID) {
      throw new PipelineError("Pipeline not found.", 404);
    }
    const subSnap = await db.doc(`subAccounts/${subAccountId}`).get();
    const sub = subSnap.exists ? (subSnap.data() as SubAccountDoc) : null;
    current = {
      id: DEFAULT_PIPELINE_ID,
      name: "Pipeline",
      stages: materializedDefaultStages(sub?.pipelineStages),
      order: -1,
      createdAt: null,
      updatedAt: null,
    };
  }

  const nextName =
    input.name !== undefined
      ? typeof input.name === "string"
        ? input.name
        : ""
      : current.name;
  const nextStagesRaw = input.stages !== undefined ? input.stages : current.stages;
  const valid = validatePipelineShape({ name: nextName, stages: nextStagesRaw });
  if (!valid.ok) throw new PipelineError(valid.error);

  // A surviving stage id must keep its terminal category (rename/tone/reorder are fine).
  const prevById = new Map(current.stages.map((s) => [s.id, s]));
  for (const s of valid.stages) {
    const prev = prevById.get(s.id);
    if (prev && (prev.terminal ?? null) !== (s.terminal ?? null)) {
      throw new PipelineError(
        `Stage "${s.label}" can't change its Won/Lost role — add a new stage instead.`,
      );
    }
  }

  const nextIds = new Set(valid.stages.map((s) => s.id));
  const removed = current.stages.filter((s) => !nextIds.has(s.id));
  const removedTerminal = removed.find((s) => s.terminal);
  if (removedTerminal) {
    throw new PipelineError(
      `The ${removedTerminal.terminal === "won" ? "Won" : "Lost"} stage can't be removed (rename it instead).`,
    );
  }
  if (removed.length > 0) {
    const occupants = await dealsInStages(
      subAccountId,
      pipelineId,
      removed.map((s) => s.id),
    );
    if (occupants.length > 0) {
      const moveTo =
        typeof input.moveDealsTo === "string" ? input.moveDealsTo : null;
      if (!moveTo || !nextIds.has(moveTo)) {
        const counts: Record<string, number> = {};
        for (const d of occupants) {
          const sid = (d.data() as Deal).stageId;
          counts[sid] = (counts[sid] ?? 0) + 1;
        }
        throw new PipelineError(
          JSON.stringify({
            code: "deals_in_removed_stages",
            counts,
            total: occupants.length,
          }),
          409,
        );
      }
      // 500 ops per batch cap.
      for (let i = 0; i < occupants.length; i += 450) {
        const batch = db.batch();
        for (const d of occupants.slice(i, i + 450)) {
          batch.update(d.ref, {
            stageId: moveTo,
            stageChangedAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });
        }
        await batch.commit();
      }
      console.log(
        `[pipelines] sa=${subAccountId} pipeline=${pipelineId} removed ${removed.length} stage(s); moved ${occupants.length} deal(s) to "${moveTo}"`,
      );
    }
  }

  const order =
    typeof input.order === "number" && Number.isFinite(input.order)
      ? Math.floor(input.order)
      : current.order;

  await ref.set(
    {
      id: pipelineId,
      name: valid.name,
      stages: valid.stages,
      order: pipelineId === DEFAULT_PIPELINE_ID ? -1 : order,
      updatedAt: FieldValue.serverTimestamp(),
      ...(snap.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
    },
    { merge: true },
  );
}

/** Refuses while any deal references it. The default can't be deleted. */
export async function deletePipeline(
  subAccountId: string,
  pipelineId: string,
): Promise<void> {
  if (pipelineId === DEFAULT_PIPELINE_ID) {
    throw new PipelineError("The default pipeline can't be deleted.");
  }
  const ref = pipelinesCol(subAccountId).doc(pipelineId);
  const snap = await ref.get();
  if (!snap.exists) throw new PipelineError("Pipeline not found.", 404);

  const deals = await getAdminDb()
    .collection("deals")
    .where("subAccountId", "==", subAccountId)
    .where("pipelineId", "==", pipelineId)
    .limit(1)
    .get();
  if (!deals.empty) {
    throw new PipelineError(
      "This pipeline still has deals. Move or delete them first.",
      409,
    );
  }
  await ref.delete();
}

/**
 * GHL import. Appends Won/Lost terminals (GHL tracks outcome as status) and
 * returns the doc plus a name-to-stageId map. Throws PipelineError(409) at the
 * cap; the caller then squash-maps instead.
 */
export async function createImportedPipeline(
  subAccountId: string,
  input: { name: string; stageNames: string[] },
): Promise<{ doc: PipelineDoc; stageIdByName: Map<string, string> }> {
  const ids = new Set<string>();
  const stages: PipelineStageDef[] = [];
  const stageIdByName = new Map<string, string>();
  const toneCycle = [
    "bg-slate-500/10 text-slate-700 dark:text-slate-300",
    "bg-blue-500/10 text-blue-700 dark:text-blue-300",
    "bg-indigo-500/10 text-indigo-700 dark:text-indigo-300",
    "bg-violet-500/10 text-violet-700 dark:text-violet-300",
    "bg-amber-500/10 text-amber-700 dark:text-amber-300",
    "bg-teal-500/10 text-teal-700 dark:text-teal-300",
    "bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
    "bg-orange-500/10 text-orange-700 dark:text-orange-300",
  ];
  // Keep the first cap-2 stages; the caller's fallback squashes the rest onto
  // the last kept stage.
  const kept = input.stageNames
    .map((n) => n.trim())
    .filter((n) => n.length > 0)
    .slice(0, 10);
  kept.forEach((name, i) => {
    // Labels must be unique; suffix duplicates.
    let label = name.slice(0, 30);
    let n = 2;
    while (stages.some((s) => s.label.toLowerCase() === label.toLowerCase())) {
      label = `${name.slice(0, 26)} (${n++})`;
    }
    const id = uniqueSlug(label, ids);
    ids.add(id);
    stages.push({ id, label, tone: toneCycle[i % toneCycle.length] });
    stageIdByName.set(name.toLowerCase(), id);
  });
  if (stages.length === 0) {
    stages.push({ id: "new", label: "New", tone: toneCycle[0] });
  }
  stages.push({
    id: uniqueSlug("won", ids),
    label: "Won",
    tone: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    terminal: "won",
  });
  ids.add(stages[stages.length - 1].id);
  stages.push({
    id: uniqueSlug("lost", ids),
    label: "Lost",
    tone: "bg-rose-500/10 text-rose-700 dark:text-rose-300",
    terminal: "lost",
  });

  const doc = await createPipeline(subAccountId, {
    name: input.name.trim().slice(0, 40) || "Imported pipeline",
    stages,
  });
  return { doc, stageIdByName };
}

export { slugify };
