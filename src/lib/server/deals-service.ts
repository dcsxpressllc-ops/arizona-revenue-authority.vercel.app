import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { emitWebhookEvent } from "@/lib/api/webhooks/dispatch";
import { fireWorkflowTrigger } from "@/lib/workflows/engine";
import { runAfterResponse } from "@/lib/server/after-response";
import {
  serializeDealForApi,
  type DealApiObject,
} from "@/lib/api/serializers/deals";
import { getStage, type DealPriority, type PipelineStageId } from "@/types/deals";
import {
  dealPipelineId,
  getPipeline,
  lostStageId,
  wonStageId,
} from "@/lib/pipelines/resolve";
import {
  loadResolvedPipelines,
  PipelineError,
} from "@/lib/server/pipelines-service";
import { DEFAULT_PIPELINE_ID } from "@/types/pipelines";
import type { WebhookEventType } from "@/types/webhooks";
import type { CustomFieldValue } from "@/types/custom-fields";
import { GLOBAL_TERRITORY_ID } from "@/types";

/**
 * Single place a deal is created/moved/updated/deleted and its webhook fires
 * (same idea as contacts-service.ts). Matches PATCH /api/v1/deals/:id: every
 * write emits deal.updated; a stage change adds deal.stage.changed, deal.won /
 * deal.lost when entering a terminal, and a pipeline_moved activity.
 */

type Mode = "live" | "test";

/** Contact inlined in deal webhook payloads so subscribers skip a lookup. Null
 *  when there's no contact or it can't be read. */
export interface DealContactSummary {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
}

function cleanStr(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function summaryFromContactData(
  contactId: string,
  data: FirebaseFirestore.DocumentData,
): DealContactSummary {
  return {
    id: contactId,
    name: cleanStr(data.name),
    email: cleanStr(data.email),
    phone: cleanStr(data.phone),
  };
}

export async function fetchDealContactSummary(
  contactId: string | null | undefined,
): Promise<DealContactSummary | null> {
  if (!contactId) return null;
  try {
    const snap = await getAdminDb().doc(`contacts/${contactId}`).get();
    if (!snap.exists) return null;
    return summaryFromContactData(contactId, snap.data()!);
  } catch {
    return null;
  }
}

/**
 * Fire deal webhook events with `contact: { id, name, email, phone } | null`
 * attached. The contact is looked up once per call; pass `contact` to skip it
 * (already read, or deleted in a cascade). Both the dashboard and /api/v1/deals
 * go through here so every event has the same shape.
 */
export function emitDealEvents(opts: {
  subAccountId: string;
  agencyId: string;
  mode: Mode;
  deal: DealApiObject;
  events: { type: WebhookEventType; extra?: Record<string, unknown> }[];
  contact?: DealContactSummary | null;
}): void {
  // Scheduled before the lookup so Vercel can't freeze mid-read and drop the events.
  runAfterResponse(async () => {
    try {
      const contact =
        opts.contact !== undefined
          ? opts.contact
          : await fetchDealContactSummary(opts.deal.contact_id);
      for (const e of opts.events) {
        await emitWebhookEvent({
          subAccountId: opts.subAccountId,
          agencyId: opts.agencyId,
          mode: opts.mode,
          type: e.type,
          payload: { deal: opts.deal, contact, ...(e.extra ?? {}) },
        });
      }
    } catch (err) {
      console.warn("[deals-service] emitDealEvents failed", err);
    }
  });
}

async function writePipelineActivity(
  contactId: string,
  payload: {
    content: string;
    createdBy: string;
    meta: Record<string, unknown>;
  },
): Promise<void> {
  await getAdminDb()
    .collection("contacts")
    .doc(contactId)
    .collection("activities")
    .add({
      type: "pipeline_moved",
      content: payload.content,
      createdBy: payload.createdBy,
      meta: payload.meta,
      createdAt: FieldValue.serverTimestamp(),
    });
}

export interface CreateDealInput {
  subAccountId: string;
  agencyId: string;
  createdByUid: string;
  mode: Mode;
  title: string;
  value: number;
  currency: string;
  contactId: string;
  /** Absent/null/"default" = default pipeline (field omitted on the doc). */
  pipelineId?: string | null;
  stageId: PipelineStageId;
  priority: DealPriority;
  territoryId?: string | null;
  customFields?: Record<string, CustomFieldValue> | null;
}

export interface DealWriteResult {
  id: string;
  deal: DealApiObject;
}

/** Create + log activity + emit deal.created. */
export async function createDealServerSide(
  input: CreateDealInput,
): Promise<DealWriteResult> {
  const db = getAdminDb();
  const ref = db.collection("deals").doc();

  // Default pipeline is stored by omitting the field, so new default deals look
  // the same as older ones.
  const normalizedPipelineId =
    typeof input.pipelineId === "string" &&
    input.pipelineId.length > 0 &&
    input.pipelineId !== DEFAULT_PIPELINE_ID
      ? input.pipelineId
      : null;
  const pipelines = await loadResolvedPipelines(input.subAccountId);
  const pipeline = getPipeline(pipelines, normalizedPipelineId);
  if (normalizedPipelineId && pipeline.id !== normalizedPipelineId) {
    throw new PipelineError(`Pipeline "${normalizedPipelineId}" not found.`, 400);
  }
  const stage = pipeline.stages.find((s) => s.id === input.stageId);
  if (!stage) {
    throw new PipelineError(
      `Stage "${input.stageId}" doesn't exist in the "${pipeline.name}" pipeline.`,
      400,
    );
  }

  const doc = {
    title: input.title,
    value: input.value,
    currency: input.currency,
    contactId: input.contactId,
    ...(normalizedPipelineId ? { pipelineId: normalizedPipelineId } : {}),
    stageId: input.stageId,
    priority: input.priority,
    lostReason: null,
    customFields: input.customFields ?? {},
    territoryId: input.territoryId ?? GLOBAL_TERRITORY_ID,
    agencyId: input.agencyId,
    subAccountId: input.subAccountId,
    createdByUid: input.createdByUid,
    mode: input.mode,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    stageChangedAt: FieldValue.serverTimestamp(),
  };
  await ref.set(doc);

  await writePipelineActivity(input.contactId, {
    content: `Deal "${input.title}" created in ${stage.label}${
      pipeline.id !== DEFAULT_PIPELINE_ID ? ` (${pipeline.name})` : ""
    }`,
    createdBy: input.createdByUid,
    meta: { dealId: ref.id, toStageId: input.stageId, pipelineId: pipeline.id },
  });

  const now = new Date();
  const deal = serializeDealForApi(
    ref.id,
    { ...doc, createdAt: now, updatedAt: now, stageChangedAt: now },
    input.mode,
  );

  emitDealEvents({
    subAccountId: input.subAccountId,
    agencyId: input.agencyId,
    mode: input.mode,
    deal,
    events: [{ type: "deal.created" }],
  });

  return { id: ref.id, deal };
}

/**
 * Patch a deal: field edits, contact re-home and stage moves in one call (the
 * edit dialog sends everything; a Kanban drag sends stageId + maybe lostReason).
 * `userId` authors the move activity. Null if the deal doesn't exist.
 */
export interface UpdateDealPatch {
  title?: string;
  value?: number;
  currency?: string;
  priority?: DealPriority;
  contactId?: string;
  territoryId?: string | null;
  /** Cross-pipeline move ("default" = default pipeline); stageId is validated
   *  against the target pipeline. */
  pipelineId?: string;
  stageId?: PipelineStageId;
  /** Only used on a move to lost. */
  lostReason?: string | null;
  /** "Completed" tick on a Won card; stamps/clears completedAt. */
  completed?: boolean;
  /** Replaces the whole map (validated by the route). */
  customFields?: Record<string, CustomFieldValue> | null;
}

export async function updateDealServerSide(opts: {
  dealId: string;
  patch: UpdateDealPatch;
  userId: string;
  mode?: Mode;
  /**
   * Tenancy guard: refuse (return null, like a missing doc) unless the deal's
   * subAccountId matches. Without it any deal id can be changed, so callers with
   * untrusted ids (AI Suite, request payloads) must pass this.
   */
  expectedSubAccountId?: string;
}): Promise<DealWriteResult | null> {
  const db = getAdminDb();
  const ref = db.doc(`deals/${opts.dealId}`);
  const snap = await ref.get();
  if (!snap.exists) return null;
  if (
    opts.expectedSubAccountId !== undefined &&
    snap.data()?.subAccountId !== opts.expectedSubAccountId
  ) {
    return null;
  }

  const existing = snap.data()!;
  const mode = opts.mode ?? (existing.mode as Mode) ?? "live";
  const previousStage = existing.stageId as PipelineStageId | undefined;
  const { patch } = opts;

  // Resolved lazily so plain field edits skip the read.
  const previousPipelineId = dealPipelineId({
    pipelineId: existing.pipelineId as string | null | undefined,
  });
  const targetPipelineId =
    patch.pipelineId !== undefined
      ? patch.pipelineId === DEFAULT_PIPELINE_ID || patch.pipelineId === ""
        ? DEFAULT_PIPELINE_ID
        : patch.pipelineId
      : previousPipelineId;
  const pipelineChanged = targetPipelineId !== previousPipelineId;
  const stageTouched = patch.stageId !== undefined || pipelineChanged;
  let prevWonId = "won";
  let prevLostId = "lost";
  let targetWonId = "won";
  let targetLostId = "lost";
  let prevStageLabel = previousStage ? getStage(previousStage).label : "";
  let nextStageLabel = patch.stageId ? getStage(patch.stageId).label : "";
  let targetPipelineName = "";
  if (stageTouched) {
    const pipelines = await loadResolvedPipelines(
      existing.subAccountId as string,
    );
    const prevPipeline = getPipeline(pipelines, previousPipelineId);
    const targetPipeline = getPipeline(pipelines, targetPipelineId);
    if (pipelineChanged && targetPipeline.id !== targetPipelineId) {
      throw new PipelineError(`Pipeline "${targetPipelineId}" not found.`, 400);
    }
    const effectiveStageId = patch.stageId ?? (previousStage as string);
    if (!targetPipeline.stages.some((s) => s.id === effectiveStageId)) {
      throw new PipelineError(
        `Stage "${effectiveStageId}" doesn't exist in the "${targetPipeline.name}" pipeline.`,
        400,
      );
    }
    prevWonId = wonStageId(prevPipeline);
    prevLostId = lostStageId(prevPipeline);
    targetWonId = wonStageId(targetPipeline);
    targetLostId = lostStageId(targetPipeline);
    prevStageLabel = previousStage
      ? (prevPipeline.stages.find((s) => s.id === previousStage)?.label ??
        previousStage)
      : "";
    nextStageLabel =
      targetPipeline.stages.find((s) => s.id === effectiveStageId)?.label ??
      effectiveStageId;
    targetPipelineName =
      targetPipeline.id !== DEFAULT_PIPELINE_ID ? targetPipeline.name : "";
  }

  const write: Record<string, unknown> = {
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (patch.title !== undefined) write.title = patch.title;
  if (patch.value !== undefined) write.value = patch.value;
  if (patch.currency !== undefined) write.currency = patch.currency;
  if (patch.priority !== undefined) write.priority = patch.priority;
  if (patch.contactId !== undefined) write.contactId = patch.contactId;
  if (patch.territoryId !== undefined) write.territoryId = patch.territoryId;
  if (patch.customFields !== undefined) write.customFields = patch.customFields;
  if (patch.completed !== undefined) {
    write.completed = patch.completed;
    write.completedAt = patch.completed ? FieldValue.serverTimestamp() : null;
  }
  if (pipelineChanged) {
    // "default" is stored as null; dealPipelineId() treats them the same.
    write.pipelineId =
      targetPipelineId === DEFAULT_PIPELINE_ID ? null : targetPipelineId;
  }

  // A cross-pipeline move is a stage change even if the slug matches.
  const effectiveNextStage = patch.stageId ?? (previousStage as string);
  const stageChanged =
    (patch.stageId !== undefined && patch.stageId !== previousStage) ||
    pipelineChanged;
  if (patch.stageId !== undefined || pipelineChanged) {
    write.stageId = effectiveNextStage;
    if (stageChanged) {
      write.stageChangedAt = FieldValue.serverTimestamp();
      // Set the reason entering lost, clear it leaving. Terminal ids are per pipeline.
      if (effectiveNextStage === targetLostId) {
        write.lostReason = patch.lostReason?.trim() || null;
      } else if (previousStage === prevLostId) {
        write.lostReason = null;
      }
    }
  }

  await ref.set(write, { merge: true });

  const fresh = await ref.get();
  const data = fresh.data()!;
  const deal = serializeDealForApi(fresh.id, data, mode);

  if (stageChanged && previousStage) {
    const reasonSuffix =
      effectiveNextStage === targetLostId && write.lostReason
        ? ` — ${write.lostReason as string}`
        : "";
    const pipelineSuffix = pipelineChanged
      ? ` (moved to ${targetPipelineName || "the default pipeline"})`
      : targetPipelineName
        ? ` (${targetPipelineName})`
        : "";
    await writePipelineActivity(data.contactId, {
      content: `Deal "${data.title}" moved from ${prevStageLabel} to ${nextStageLabel}${pipelineSuffix}${reasonSuffix}`,
      createdBy: opts.userId,
      meta: {
        dealId: fresh.id,
        fromStageId: previousStage,
        toStageId: effectiveNextStage,
        ...(pipelineChanged
          ? { fromPipelineId: previousPipelineId, toPipelineId: targetPipelineId }
          : {}),
      },
    });
  }

  const events: { type: WebhookEventType; extra?: Record<string, unknown> }[] =
    [{ type: "deal.updated" }];
  if (stageChanged) {
    events.push({
      type: "deal.stage.changed",
      extra: {
        previous_stage: previousStage ?? null,
        ...(pipelineChanged
          ? { previous_pipeline_id: previousPipelineId }
          : {}),
      },
    });
    // Only on entering a terminal, not when an already won/lost deal changes pipeline.
    const wasWon = previousStage === prevWonId;
    const wasLost = previousStage === prevLostId;
    if (effectiveNextStage === targetWonId && !wasWon) {
      events.push({ type: "deal.won" });
    } else if (effectiveNextStage === targetLostId && !wasLost) {
      events.push({ type: "deal.lost" });
    }
  }
  emitDealEvents({
    subAccountId: existing.subAccountId,
    agencyId: existing.agencyId,
    mode,
    deal,
    events,
  });

  // Runs are contact-scoped, so a stage move enrolls the deal's contact.
  // `toStage` lets a workflow narrow to one stage.
  if (mode === "live" && stageChanged && data.contactId) {
    void fireWorkflowTrigger({
      subAccountId: existing.subAccountId as string,
      agencyId: existing.agencyId as string,
      type: "pipeline.stage.changed",
      contactId: data.contactId as string,
      context: { toStage: effectiveNextStage, toPipeline: targetPipelineId },
    });
  }

  return { id: fresh.id, deal };
}

/** Delete + emit deal.deleted from the pre-delete snapshot. False if missing. */
export async function deleteDealServerSide(opts: {
  dealId: string;
  mode?: Mode;
}): Promise<boolean> {
  const db = getAdminDb();
  const ref = db.doc(`deals/${opts.dealId}`);
  const snap = await ref.get();
  if (!snap.exists) return false;
  const data = snap.data()!;
  const mode = opts.mode ?? (data.mode as Mode) ?? "live";
  const deal = serializeDealForApi(snap.id, data, mode);

  await ref.delete();

  emitDealEvents({
    subAccountId: data.subAccountId,
    agencyId: data.agencyId,
    mode,
    deal,
    events: [{ type: "deal.deleted" }],
  });
  return true;
}

/** deal.deleted for deletes outside deleteDealServerSide (contact-delete cascade,
 *  public API DELETE). */
export function emitDealDeleted(opts: {
  subAccountId: string;
  agencyId: string;
  dealId: string;
  data: FirebaseFirestore.DocumentData;
  mode?: Mode;
  /** The cascade deletes the contact first, so pass the data the route already
   *  read. Omit to look it up. */
  contactData?: FirebaseFirestore.DocumentData | null;
}): void {
  const mode = opts.mode ?? (opts.data.mode as Mode) ?? "live";
  const deal = serializeDealForApi(opts.dealId, opts.data, mode);
  const contactId = opts.data.contactId as string | null | undefined;
  const contact =
    opts.contactData !== undefined
      ? contactId
        ? summaryFromContactData(contactId, opts.contactData ?? {})
        : null
      : undefined;
  emitDealEvents({
    subAccountId: opts.subAccountId,
    agencyId: opts.agencyId,
    mode,
    deal,
    events: [{ type: "deal.deleted" }],
    contact,
  });
}

/** deal.created for a deal written elsewhere (public form submit). Safe to
 *  `void`; scheduled before the read like emitContactCreatedById. */
export async function emitDealCreatedById(opts: {
  subAccountId: string;
  agencyId: string;
  dealId: string;
  mode?: Mode;
}): Promise<void> {
  runAfterResponse(() => runEmitDealCreatedById(opts));
}

async function runEmitDealCreatedById(opts: {
  subAccountId: string;
  agencyId: string;
  dealId: string;
  mode?: Mode;
}): Promise<void> {
  try {
    const snap = await getAdminDb().doc(`deals/${opts.dealId}`).get();
    if (!snap.exists) return;
    const mode = opts.mode ?? (snap.data()!.mode as Mode) ?? "live";
    const deal = serializeDealForApi(snap.id, snap.data()!, mode);
    emitDealEvents({
      subAccountId: opts.subAccountId,
      agencyId: opts.agencyId,
      mode,
      deal,
      events: [{ type: "deal.created" }],
    });
  } catch (err) {
    console.warn("[deals-service] emitDealCreatedById failed", err);
  }
}
