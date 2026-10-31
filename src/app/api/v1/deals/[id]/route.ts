import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { withApiAuth } from "@/lib/api/auth";
import { apiError, apiOk } from "@/lib/api/responses";
import { emitDealEvents } from "@/lib/server/deals-service";
import {
  parseDealPatch,
  serializeDealForApi,
} from "@/lib/api/serializers/deals";
import { loadResolvedPipelines } from "@/lib/server/pipelines-service";
import {
  dealPipelineId,
  getPipeline,
  lostStageId,
  wonStageId,
} from "@/lib/pipelines/resolve";
import { DEFAULT_PIPELINE_ID } from "@/types/pipelines";
import { loadCustomFieldDefs } from "@/lib/custom-fields/load-defs";
import { validateCustomFieldValues } from "@/lib/custom-fields/validation";
import type { WebhookEventType } from "@/types/webhooks";

/**
 * Public API v1, single deal: GET, PATCH (partial), DELETE.
 * Changing `stage` updates stageChangedAt and emits deal.stage.changed;
 * entering won/lost also emits deal.won / deal.lost.
 */

export const GET = withApiAuth<{ id: string }>(async ({ params, ctx }) => {
  const snap = await getAdminDb().doc(`deals/${params.id}`).get();
  if (!snap.exists) {
    return apiError(ctx, "not_found", "deal_not_found", "Deal not found.");
  }
  const data = snap.data()!;
  if (data.subAccountId !== ctx.subAccountId || data.mode !== ctx.mode) {
    return apiError(ctx, "not_found", "deal_not_found", "Deal not found.");
  }
  return apiOk(ctx, { deal: serializeDealForApi(snap.id, data, ctx.mode) });
});

export const PATCH = withApiAuth<{ id: string }>(async ({ body, params, ctx }) => {
  const parsed = parseDealPatch(body);
  if (!parsed.ok) {
    return apiError(ctx, "invalid_request", "invalid_body", parsed.error!);
  }
  const patch = parsed.value!;

  const ref = getAdminDb().doc(`deals/${params.id}`);
  const snap = await ref.get();
  if (!snap.exists) {
    return apiError(ctx, "not_found", "deal_not_found", "Deal not found.");
  }
  const existing = snap.data()!;
  if (existing.subAccountId !== ctx.subAccountId || existing.mode !== ctx.mode) {
    return apiError(ctx, "not_found", "deal_not_found", "Deal not found.");
  }

  const previousStage = existing.stageId as string | undefined;
  const writePatch: Record<string, unknown> = {
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (patch.title !== undefined) writePatch.title = patch.title;
  if (patch.value !== undefined) writePatch.value = patch.value;
  if (patch.currency !== undefined) writePatch.currency = patch.currency;
  if (patch.priority !== undefined) writePatch.priority = patch.priority;
  if (patch.lostReason !== undefined) writePatch.lostReason = patch.lostReason;
  if (patch.territoryId !== undefined) writePatch.territoryId = patch.territoryId;

  if ((body as Record<string, unknown>).custom_fields !== undefined) {
    const cfDefs = await loadCustomFieldDefs(
      existing.subAccountId as string,
      "deal",
    );
    const cf = validateCustomFieldValues(
      (body as Record<string, unknown>).custom_fields,
      cfDefs,
    );
    if (!cf.ok) {
      return apiError(ctx, "invalid_request", "invalid_body", cf.error!);
    }
    writePatch.customFields = cf.value;
  }

  // Pipeline and stage are validated against the target pipeline's live
  // stages; moving across pipelines counts as a stage change.
  const previousPipelineId = dealPipelineId({
    pipelineId: existing.pipelineId as string | null | undefined,
  });
  const targetPipelineId = patch.pipelineId ?? previousPipelineId;
  const pipelineChanged = targetPipelineId !== previousPipelineId;
  let prevWon = "won";
  let prevLost = "lost";
  let targetWon = "won";
  let targetLost = "lost";
  if (patch.stage !== undefined || pipelineChanged) {
    const pipelines = await loadResolvedPipelines(ctx.subAccountId);
    const targetPipeline = getPipeline(pipelines, targetPipelineId);
    if (pipelineChanged && targetPipeline.id !== targetPipelineId) {
      return apiError(
        ctx,
        "invalid_request",
        "pipeline_not_found",
        `pipeline_id=${targetPipelineId} does not exist. See GET /v1/pipelines.`,
      );
    }
    const effectiveStage = patch.stage ?? (previousStage as string);
    if (!targetPipeline.stages.some((s) => s.id === effectiveStage)) {
      return apiError(
        ctx,
        "invalid_request",
        "invalid_stage",
        `stage=${effectiveStage} does not exist in pipeline "${targetPipeline.id}". Valid: ${targetPipeline.stages.map((s) => s.id).join(", ")}.`,
      );
    }
    const prevPipeline = getPipeline(pipelines, previousPipelineId);
    prevWon = wonStageId(prevPipeline);
    prevLost = lostStageId(prevPipeline);
    targetWon = wonStageId(targetPipeline);
    targetLost = lostStageId(targetPipeline);
  }

  const stageChanged =
    (patch.stage !== undefined && patch.stage !== previousStage) ||
    pipelineChanged;
  const effectiveNextStage = patch.stage ?? (previousStage as string);
  if (patch.stage !== undefined || pipelineChanged) {
    writePatch.stageId = effectiveNextStage;
    if (pipelineChanged) {
      writePatch.pipelineId =
        targetPipelineId === DEFAULT_PIPELINE_ID ? null : targetPipelineId;
    }
    if (stageChanged) {
      writePatch.stageChangedAt = FieldValue.serverTimestamp();
    }
  }

  await ref.set(writePatch, { merge: true });

  const fresh = await ref.get();
  const wire = serializeDealForApi(fresh.id, fresh.data()!, ctx.mode);

  // deal.updated always. Stage changes add deal.stage.changed, and entering a
  // terminal (per-pipeline ids) adds deal.won/deal.lost.
  const events: { type: WebhookEventType; extra?: Record<string, unknown> }[] =
    [{ type: "deal.updated" }];
  if (stageChanged) {
    events.push({
      type: "deal.stage.changed",
      extra: {
        previous_stage: previousStage ?? null,
        ...(pipelineChanged ? { previous_pipeline_id: previousPipelineId } : {}),
      },
    });
    const wasWon = previousStage === prevWon;
    const wasLost = previousStage === prevLost;
    if (effectiveNextStage === targetWon && !wasWon) {
      events.push({ type: "deal.won" });
    } else if (effectiveNextStage === targetLost && !wasLost) {
      events.push({ type: "deal.lost" });
    }
  }
  emitDealEvents({
    subAccountId: ctx.subAccountId,
    agencyId: ctx.agencyId,
    mode: ctx.mode,
    deal: wire,
    events,
  });

  return apiOk(ctx, { deal: wire });
});

export const DELETE = withApiAuth<{ id: string }>(async ({ params, ctx }) => {
  const ref = getAdminDb().doc(`deals/${params.id}`);
  const snap = await ref.get();
  if (!snap.exists) {
    return apiError(ctx, "not_found", "deal_not_found", "Deal not found.");
  }
  const existing = snap.data()!;
  if (existing.subAccountId !== ctx.subAccountId || existing.mode !== ctx.mode) {
    return apiError(ctx, "not_found", "deal_not_found", "Deal not found.");
  }
  await ref.delete();
  emitDealEvents({
    subAccountId: ctx.subAccountId,
    agencyId: ctx.agencyId,
    mode: ctx.mode,
    deal: serializeDealForApi(snap.id, existing, ctx.mode),
    events: [{ type: "deal.deleted" }],
  });
  return apiOk(ctx, { id: params.id, object: "deal", deleted: true });
});
