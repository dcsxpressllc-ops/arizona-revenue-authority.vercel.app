import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import {
  deleteDealServerSide,
  updateDealServerSide,
  type UpdateDealPatch,
} from "@/lib/server/deals-service";
import { contactBelongsToOtherSubAccount } from "@/lib/server/contacts-service";
import {
  PipelineError,
  wonStageIdForDeal,
} from "@/lib/server/pipelines-service";
import { maybeSendReviewRequest } from "@/lib/reviews/request";
import { loadCustomFieldDefs } from "@/lib/custom-fields/load-defs";
import { validateCustomFieldValues } from "@/lib/custom-fields/validation";
import { DEAL_PRIORITIES } from "@/types/deals";
import type { DealPriority, PipelineStageId } from "@/types/deals";
import { runAfterResponse } from "@/lib/server/after-response";

/**
 * PATCH: edit fields, stage or pipeline (deal.updated + deal.stage.*).
 * DELETE: deal.deleted. Stage validation is pipeline-aware, in the service.
 */

const VALID_PRIORITIES = new Set(DEAL_PRIORITIES.map((p) => p.id));

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const db = getAdminDb();
  const snap = await db.doc(`deals/${id}`).get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Deal not found" }, { status: 404 });
  }
  const data = snap.data()!;

  const access = await requireSubAccountMember(request, data.subAccountId);
  if (access instanceof NextResponse) return access;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const patch: UpdateDealPatch = {};
  if (typeof body.title === "string") patch.title = body.title.trim().slice(0, 200);
  if (typeof body.value === "number" && Number.isFinite(body.value) && body.value >= 0) {
    patch.value = body.value;
  }
  if (typeof body.currency === "string" && body.currency.length === 3) {
    patch.currency = body.currency.toUpperCase();
  }
  if (VALID_PRIORITIES.has(body.priority as DealPriority)) {
    patch.priority = body.priority as DealPriority;
  }
  if (typeof body.contactId === "string" && body.contactId.trim()) {
    const contactId = body.contactId.trim();
    if (await contactBelongsToOtherSubAccount(contactId, data.subAccountId)) {
      return NextResponse.json({ error: "Contact not found" }, { status: 404 });
    }
    patch.contactId = contactId;
  }
  if (body.territoryId === null || typeof body.territoryId === "string") {
    patch.territoryId =
      typeof body.territoryId === "string" ? body.territoryId : null;
  }
  if (body.stageId !== undefined) {
    if (typeof body.stageId !== "string" || body.stageId.length === 0) {
      return NextResponse.json({ error: "Invalid stageId" }, { status: 400 });
    }
    patch.stageId = body.stageId as PipelineStageId;
  }
  if (typeof body.pipelineId === "string" && body.pipelineId.length > 0) {
    patch.pipelineId = body.pipelineId;
  }
  if (body.lostReason === null || typeof body.lostReason === "string") {
    patch.lostReason =
      typeof body.lostReason === "string" ? body.lostReason : null;
  }
  if (typeof body.completed === "boolean") patch.completed = body.completed;
  if (body.customFields !== undefined) {
    const defs = await loadCustomFieldDefs(data.subAccountId as string, "deal");
    const cf = validateCustomFieldValues(body.customFields, defs);
    if (!cf.ok) {
      return NextResponse.json({ error: cf.error }, { status: 400 });
    }
    patch.customFields = cf.value;
  }

  let result: Awaited<ReturnType<typeof updateDealServerSide>>;
  try {
    result = await updateDealServerSide({
      dealId: id,
      patch,
      userId: access.uid,
      mode: (data.mode as "live" | "test") ?? "live",
    });
  } catch (err) {
    if (err instanceof PipelineError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
  if (!result) {
    return NextResponse.json({ error: "Deal not found" }, { status: 404 });
  }

  // Auto review request the first time a Won deal is marked completed. The
  // dispatcher re-checks review config and cooldown. "Won" is resolved per
  // pipeline since custom pipelines have their own won-stage id.
  const becameCompleted = patch.completed === true && data.completed !== true;
  const effectiveStage = patch.stageId ?? (data.stageId as PipelineStageId);
  const wonId = becameCompleted
    ? await wonStageIdForDeal(data.subAccountId as string, {
        pipelineId:
          patch.pipelineId ?? (data.pipelineId as string | null | undefined),
      })
    : "won";
  if (becameCompleted && effectiveStage === wonId) {
    runAfterResponse(() => maybeSendReviewRequest({
      subAccountId: data.subAccountId as string,
      agencyId: data.agencyId as string,
      contactId: (result.deal.contact_id ?? data.contactId) as string,
      trigger: "deal_completed",
    }));
  }

  return NextResponse.json({ deal: result.deal });
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const db = getAdminDb();
  const snap = await db.doc(`deals/${id}`).get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Deal not found" }, { status: 404 });
  }
  const data = snap.data()!;

  const access = await requireSubAccountMember(request, data.subAccountId);
  if (access instanceof NextResponse) return access;

  await deleteDealServerSide({
    dealId: id,
    mode: (data.mode as "live" | "test") ?? "live",
  });
  return NextResponse.json({ id, object: "deal", deleted: true });
}
