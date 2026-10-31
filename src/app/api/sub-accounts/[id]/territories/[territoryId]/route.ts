import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { GLOBAL_TERRITORY_ID, type TerritoryStatus } from "@/types";

/**
 * PATCH: rename, change code, archive/restore.
 * DELETE: only when no deals/contacts reference the territory and no member
 * has it assigned; otherwise 409 with counts (archive instead).
 */

interface PatchBody {
  name?: string;
  code?: string | null;
  status?: TerritoryStatus;
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string; territoryId: string }> },
) {
  const { id: subAccountId, territoryId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: PatchBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const db = getAdminDb();
  const ref = db.doc(
    `subAccounts/${subAccountId}/territories/${territoryId}`,
  );
  const snap = await ref.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Territory not found" }, { status: 404 });
  }

  const patch: Record<string, unknown> = {
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (typeof body.name === "string") {
    const name = body.name.trim();
    if (name.length < 1 || name.length > 60) {
      return NextResponse.json(
        { error: "Territory name must be 1–60 characters." },
        { status: 400 },
      );
    }
    const existing = await db
      .collection(`subAccounts/${subAccountId}/territories`)
      .get();
    const lower = name.toLowerCase();
    const dup = existing.docs.find(
      (d) =>
        d.id !== territoryId &&
        ((d.data().name as string | undefined) ?? "").toLowerCase() === lower,
    );
    if (dup) {
      return NextResponse.json(
        { error: `A territory named "${name}" already exists.` },
        { status: 409 },
      );
    }
    patch.name = name;
  }

  if (body.code !== undefined) {
    patch.code =
      typeof body.code === "string" && body.code.trim().length > 0
        ? body.code.trim().slice(0, 12)
        : null;
  }

  if (body.status === "active" || body.status === "archived") {
    // Global is the default bucket; archiving it would orphan every defaulted
    // record and member.
    if (territoryId === GLOBAL_TERRITORY_ID && body.status === "archived") {
      return NextResponse.json(
        { error: "The Global territory can't be archived." },
        { status: 400 },
      );
    }
    patch.status = body.status;
  }

  await ref.update(patch);
  return NextResponse.json({ ok: true, id: territoryId });
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string; territoryId: string }> },
) {
  const { id: subAccountId, territoryId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  if (territoryId === GLOBAL_TERRITORY_ID) {
    return NextResponse.json(
      { error: "The Global territory is the default bucket and can't be deleted." },
      { status: 400 },
    );
  }

  const db = getAdminDb();
  const ref = db.doc(
    `subAccounts/${subAccountId}/territories/${territoryId}`,
  );
  const snap = await ref.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Territory not found" }, { status: 404 });
  }

  const [dealRefs, contactRefs] = await Promise.all([
    db
      .collection("deals")
      .where("subAccountId", "==", subAccountId)
      .where("territoryId", "==", territoryId)
      .count()
      .get(),
    db
      .collection("contacts")
      .where("subAccountId", "==", subAccountId)
      .where("territoryId", "==", territoryId)
      .count()
      .get(),
  ]);
  const dealCount = dealRefs.data().count;
  const contactCount = contactRefs.data().count;

  // collectionGroup over subAccountMembers in this sub-account.
  const memberRefs = await db
    .collection(`subAccounts/${subAccountId}/subAccountMembers`)
    .get();
  const memberCount = memberRefs.docs.filter((d) => {
    const ids = (d.data().assignedTerritoryIds as string[] | undefined) ?? [];
    return ids.includes(territoryId);
  }).length;

  if (dealCount > 0 || contactCount > 0 || memberCount > 0) {
    return NextResponse.json(
      {
        error:
          "Territory is still referenced. Archive it instead, or reassign the records first.",
        dealCount,
        contactCount,
        memberCount,
      },
      { status: 409 },
    );
  }

  await ref.delete();
  return NextResponse.json({ ok: true, id: territoryId });
}
