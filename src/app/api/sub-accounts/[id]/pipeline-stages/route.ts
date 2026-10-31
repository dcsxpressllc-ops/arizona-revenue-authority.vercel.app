import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { PIPELINE_STAGES } from "@/types/deals";
import type { CanonicalStageId, PipelineStageOverride } from "@/types/deals";

/**
 * PATCH: label/order overrides for the canonical pipeline stages, or reset.
 * Admin only.
 *
 * Invariants: only the 6 canonical ids are accepted (no add/remove, no
 * duplicates). Only `label` and `order` are stored; `id` and the won/lost
 * `terminal` flags always come from PIPELINE_STAGES, so this can't affect
 * stageIds, the API, webhooks or reports. `reset: true` deletes the field.
 */

const CANONICAL_IDS = PIPELINE_STAGES.map((s) => s.id) as CanonicalStageId[];
const CANONICAL_ID_SET = new Set<string>(CANONICAL_IDS);
const LABEL_MAX = 40;

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const db = getAdminDb();
  const ref = db.doc(`subAccounts/${subAccountId}`);
  const snap = await ref.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Sub-account not found" }, { status: 404 });
  }

  if (b.reset === true) {
    await ref.update({
      pipelineStages: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return NextResponse.json({ ok: true, reset: true });
  }

  if (!Array.isArray(b.stages)) {
    return NextResponse.json(
      { error: "`stages` must be an array (or pass `reset: true`)." },
      { status: 400 },
    );
  }

  const seen = new Set<string>();
  const cleaned: PipelineStageOverride[] = [];
  for (const raw of b.stages) {
    if (typeof raw !== "object" || raw === null) {
      return NextResponse.json(
        { error: "Each stage must be an object." },
        { status: 400 },
      );
    }
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id : "";
    if (!CANONICAL_ID_SET.has(id)) {
      return NextResponse.json(
        { error: `Unknown stage id "${id}". Stages can't be added or removed.` },
        { status: 400 },
      );
    }
    if (seen.has(id)) {
      return NextResponse.json(
        { error: `Duplicate stage "${id}".` },
        { status: 400 },
      );
    }
    seen.add(id);

    const label = typeof r.label === "string" ? r.label.trim() : "";
    if (label.length < 1 || label.length > LABEL_MAX) {
      return NextResponse.json(
        { error: `Each stage label must be 1–${LABEL_MAX} characters.` },
        { status: 400 },
      );
    }
    const order = Number(r.order);
    if (!Number.isFinite(order)) {
      return NextResponse.json(
        { error: "Each stage needs a numeric order." },
        { status: 400 },
      );
    }
    cleaned.push({ id: id as CanonicalStageId, label, order: Math.floor(order) });
  }

  // Full set required so a save is an unambiguous replacement.
  if (cleaned.length !== CANONICAL_IDS.length) {
    return NextResponse.json(
      { error: "Send all pipeline stages (label + order for each)." },
      { status: 400 },
    );
  }

  await ref.update({
    pipelineStages: cleaned,
    updatedAt: FieldValue.serverTimestamp(),
  });
  return NextResponse.json({ ok: true });
}
