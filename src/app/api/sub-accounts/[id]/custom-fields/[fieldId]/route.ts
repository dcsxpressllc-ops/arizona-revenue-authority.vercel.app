import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { CUSTOM_FIELD_OPTION_TYPES } from "@/types/custom-fields";
import type { CustomFieldDef } from "@/types/custom-fields";

/**
 * Admin only. PATCH edits label, options, required and order. `entity`,
 * `key` and `type` are immutable since stored values are keyed by `key` and
 * typed by `type`; delete and recreate instead. DELETE leaves existing
 * values in place as orphaned keys that just stop rendering.
 */

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string; fieldId: string }> },
) {
  const { id: subAccountId, fieldId } = await ctx.params;
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
  const ref = db.doc(`subAccounts/${subAccountId}/customFields/${fieldId}`);
  const snap = await ref.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Custom field not found" }, { status: 404 });
  }
  const def = snap.data() as Omit<CustomFieldDef, "id">;

  const update: Record<string, unknown> = {
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (b.label !== undefined) {
    const label = typeof b.label === "string" ? b.label.trim() : "";
    if (label.length < 1 || label.length > 60) {
      return NextResponse.json(
        { error: "Field label must be 1–60 characters." },
        { status: 400 },
      );
    }
    update.label = label;
  }

  if (b.required !== undefined) {
    update.required = b.required === true;
  }

  if (b.order !== undefined) {
    const order = Number(b.order);
    if (!Number.isFinite(order)) {
      return NextResponse.json({ error: "Order must be a number." }, { status: 400 });
    }
    update.order = Math.max(0, Math.floor(order));
  }

  if (b.options !== undefined) {
    if (!CUSTOM_FIELD_OPTION_TYPES.has(def.type)) {
      return NextResponse.json(
        { error: "Only dropdown / multi-select fields have options." },
        { status: 400 },
      );
    }
    if (!Array.isArray(b.options)) {
      return NextResponse.json({ error: "Options must be a list." }, { status: 400 });
    }
    const cleaned = Array.from(
      new Set(
        b.options
          .map((o) => (typeof o === "string" ? o.trim() : ""))
          .filter((o) => o.length > 0 && o.length <= 100),
      ),
    );
    if (cleaned.length === 0) {
      return NextResponse.json(
        { error: "Keep at least one option." },
        { status: 400 },
      );
    }
    if (cleaned.length > 50) {
      return NextResponse.json({ error: "At most 50 options." }, { status: 400 });
    }
    update.options = cleaned;
  }

  await ref.update(update);
  return NextResponse.json({ ok: true, id: fieldId });
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string; fieldId: string }> },
) {
  const { id: subAccountId, fieldId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const db = getAdminDb();
  const ref = db.doc(`subAccounts/${subAccountId}/customFields/${fieldId}`);
  const snap = await ref.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Custom field not found" }, { status: 404 });
  }
  await ref.delete();
  return NextResponse.json({ ok: true, id: fieldId });
}
