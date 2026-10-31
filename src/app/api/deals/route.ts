import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { createDealServerSide } from "@/lib/server/deals-service";
import { contactBelongsToOtherSubAccount } from "@/lib/server/contacts-service";
import { PipelineError } from "@/lib/server/pipelines-service";
import { loadCustomFieldDefs } from "@/lib/custom-fields/load-defs";
import { validateCustomFieldValues } from "@/lib/custom-fields/validation";
import { DEAL_PRIORITIES } from "@/types/deals";
import type { DealPriority, PipelineStageId } from "@/types/deals";

/**
 * Dashboard deal create, via the shared service so `deal.created` fires.
 * The service validates `stageId` against the target pipeline's stages.
 */

const VALID_PRIORITIES = new Set(DEAL_PRIORITIES.map((p) => p.id));

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const subAccountId =
    typeof body.subAccountId === "string" ? body.subAccountId.trim() : "";
  if (!subAccountId) {
    return NextResponse.json({ error: "subAccountId is required" }, { status: 400 });
  }

  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const title = typeof body.title === "string" ? body.title.trim().slice(0, 200) : "";
  const contactId = typeof body.contactId === "string" ? body.contactId.trim() : "";
  if (!title) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }
  if (!contactId) {
    return NextResponse.json({ error: "contactId is required" }, { status: 400 });
  }
  if (await contactBelongsToOtherSubAccount(contactId, subAccountId)) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }

  const stageId = body.stageId as PipelineStageId;
  if (typeof stageId !== "string" || stageId.length === 0) {
    return NextResponse.json({ error: "Invalid stageId" }, { status: 400 });
  }
  const pipelineId =
    typeof body.pipelineId === "string" && body.pipelineId.length > 0
      ? body.pipelineId
      : null;
  const priority = (
    VALID_PRIORITIES.has(body.priority as DealPriority) ? body.priority : "medium"
  ) as DealPriority;

  const value =
    typeof body.value === "number" && Number.isFinite(body.value) && body.value >= 0
      ? body.value
      : 0;
  const currency =
    typeof body.currency === "string" && body.currency.length === 3
      ? body.currency.toUpperCase()
      : "USD";

  const subSnap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  const agencyId = (subSnap.data()?.agencyId as string) ?? access.agencyId ?? "";

  const defs = await loadCustomFieldDefs(subAccountId, "deal");
  const cf = validateCustomFieldValues(body.customFields, defs);
  if (!cf.ok) {
    return NextResponse.json({ error: cf.error }, { status: 400 });
  }

  try {
    const { id, deal } = await createDealServerSide({
      subAccountId,
      agencyId,
      createdByUid: access.uid,
      mode: "live",
      title,
      value,
      currency,
      contactId,
      pipelineId,
      stageId,
      priority,
      territoryId: typeof body.territoryId === "string" ? body.territoryId : null,
      customFields: cf.value,
    });
    return NextResponse.json({ id, deal }, { status: 201 });
  } catch (err) {
    if (err instanceof PipelineError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
