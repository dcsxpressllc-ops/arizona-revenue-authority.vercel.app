import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { GLOBAL_TERRITORY_ID } from "@/types";

/**
 * PATCH { enabled: boolean }: toggle territory scoping. No preconditions;
 * the settings UI warns when it's on but nothing is set up. Disabling keeps
 * territories and member assignments, so re-enabling is one click.
 */
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: { enabled?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const enabled = body.enabled === true;

  const db = getAdminDb();
  const subRef = db.doc(`subAccounts/${subAccountId}`);
  const subSnap = await subRef.get();
  if (!subSnap.exists) {
    return NextResponse.json(
      { error: "Sub-account not found" },
      { status: 404 },
    );
  }
  const agencyId = (subSnap.data()?.agencyId as string | undefined) ?? null;

  // Seed Global and put unassigned members in it, so enabling changes nothing
  // at first: everyone and everything is Global until the admin carves out
  // real territories. Idempotent.
  if (enabled && agencyId) {
    const globalRef = db.doc(
      `subAccounts/${subAccountId}/territories/${GLOBAL_TERRITORY_ID}`,
    );
    const globalSnap = await globalRef.get();
    if (!globalSnap.exists) {
      await globalRef.set({
        id: GLOBAL_TERRITORY_ID,
        subAccountId,
        agencyId,
        name: "Global",
        code: null,
        status: "active",
        createdByUid: access.uid,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    const membersSnap = await db
      .collection(`subAccounts/${subAccountId}/subAccountMembers`)
      .where("status", "==", "active")
      .get();
    const toBackfill = membersSnap.docs.filter((d) => {
      const ids = (d.data().assignedTerritoryIds as string[] | undefined) ?? [];
      return ids.length === 0;
    });
    for (let i = 0; i < toBackfill.length; i += 500) {
      const batch = db.batch();
      for (const d of toBackfill.slice(i, i + 500)) {
        batch.update(d.ref, { assignedTerritoryIds: [GLOBAL_TERRITORY_ID] });
      }
      await batch.commit();
    }

    // Records without territoryId -> Global. Otherwise collaborators see
    // nothing older than the toggle (canSeeScopedDoc() rejects null for
    // non-admins). Firestore can't query "missing field", so filter in memory.
    // updatedAt is deliberately not stamped so lists keep their real edit
    // order. Idempotent.
    const recordCollections = [
      "contacts",
      "deals",
      "tasks",
      "quotes",
      "events",
    ] as const;
    for (const col of recordCollections) {
      const snap = await db
        .collection(col)
        .where("subAccountId", "==", subAccountId)
        .get();
      const missing = snap.docs.filter((d) => !d.data().territoryId);
      for (let i = 0; i < missing.length; i += 500) {
        const batch = db.batch();
        for (const d of missing.slice(i, i + 500)) {
          batch.update(d.ref, { territoryId: GLOBAL_TERRITORY_ID });
        }
        await batch.commit();
      }
    }

    // Booking-page config docs too, so the no-unassigned invariant holds there.
    const bookingPagesSnap = await db
      .collection(`subAccounts/${subAccountId}/bookingPages`)
      .get();
    const bookingMissing = bookingPagesSnap.docs.filter(
      (d) => !d.data().territoryId,
    );
    for (let i = 0; i < bookingMissing.length; i += 500) {
      const batch = db.batch();
      for (const d of bookingMissing.slice(i, i + 500)) {
        batch.update(d.ref, { territoryId: GLOBAL_TERRITORY_ID });
      }
      await batch.commit();
    }
  }

  await subRef.update({
    territoryScopingEnabled: enabled,
    territoryScopingEnabledAt: enabled
      ? FieldValue.serverTimestamp()
      : null,
    territoryScopingEnabledByUid: enabled ? access.uid : null,
    updatedAt: FieldValue.serverTimestamp(),
  });

  return NextResponse.json({ ok: true, enabled });
}
