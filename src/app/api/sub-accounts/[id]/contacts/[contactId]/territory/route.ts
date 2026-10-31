import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { GLOBAL_TERRITORY_ID } from "@/types";

/**
 * Re-tag a contact's territory and cascade it to the account's deals,
 * quotes, tasks and events, so the whole account moves to whoever covers the
 * new territory. Admin-only.
 * Body: { territoryId: string } (empty/missing = Global)
 * Batched in 500-op chunks; usually one batch.
 */
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string; contactId: string }> },
) {
  const { id: subAccountId, contactId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: { territoryId?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  // There's no "unassigned"; Global is the floor.
  const territoryId =
    typeof body.territoryId === "string" && body.territoryId.length > 0
      ? body.territoryId
      : GLOBAL_TERRITORY_ID;

  const db = getAdminDb();

  const contactRef = db.doc(`contacts/${contactId}`);
  const contactSnap = await contactRef.get();
  if (!contactSnap.exists) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }
  if (contactSnap.data()?.subAccountId !== subAccountId) {
    return NextResponse.json(
      { error: "Contact belongs to a different sub-account" },
      { status: 403 },
    );
  }
  const fromTerritoryId =
    (contactSnap.data()?.territoryId as string | null | undefined) ?? null;

  // Global is always valid, so only look up other targets (and grab a name
  // for the timeline row).
  let toTerritoryName = "Global";
  if (territoryId !== GLOBAL_TERRITORY_ID) {
    const tSnap = await db
      .doc(`subAccounts/${subAccountId}/territories/${territoryId}`)
      .get();
    if (!tSnap.exists || tSnap.data()?.status !== "active") {
      return NextResponse.json(
        { error: "Territory doesn't exist or is archived." },
        { status: 400 },
      );
    }
    toTerritoryName = (tSnap.data()?.name as string | undefined) ?? "Unnamed";
  }

  const childCollections = ["deals", "quotes", "tasks", "events"] as const;
  const childSnaps = await Promise.all(
    childCollections.map((col) =>
      db
        .collection(col)
        .where("subAccountId", "==", subAccountId)
        .where("contactId", "==", contactId)
        .get(),
    ),
  );

  // Imported Google events stay in the shared pool; they follow their owner, not the contact.
  const eventDocs = childSnaps[3].docs.filter((d) => d.data().source !== "google");
  const refs: FirebaseFirestore.DocumentReference[] = [contactRef];
  for (const snap of childSnaps.slice(0, 3)) {
    for (const d of snap.docs) refs.push(d.ref);
  }
  for (const d of eventDocs) refs.push(d.ref);

  const counts: Record<string, number> = {
    deals: childSnaps[0].size,
    quotes: childSnaps[1].size,
    tasks: childSnaps[2].size,
    events: eventDocs.length,
  };

  const stamp = FieldValue.serverTimestamp();
  for (let i = 0; i < refs.length; i += 500) {
    const batch = db.batch();
    for (const ref of refs.slice(i, i + 500)) {
      batch.update(ref, { territoryId, updatedAt: stamp });
    }
    await batch.commit();
  }

  // Timeline entry, only when the territory actually changed. Best-effort:
  // the cascade already committed.
  if (fromTerritoryId !== territoryId) {
    let fromTerritoryName = "Global";
    if (fromTerritoryId && fromTerritoryId !== GLOBAL_TERRITORY_ID) {
      const fromSnap = await db
        .doc(`subAccounts/${subAccountId}/territories/${fromTerritoryId}`)
        .get();
      fromTerritoryName =
        (fromSnap.data()?.name as string | undefined) ?? "Unnamed";
    }
    const childParts: string[] = [];
    if (counts.deals > 0)
      childParts.push(`${counts.deals} deal${counts.deals === 1 ? "" : "s"}`);
    if (counts.quotes > 0)
      childParts.push(`${counts.quotes} quote${counts.quotes === 1 ? "" : "s"}`);
    if (counts.tasks > 0)
      childParts.push(`${counts.tasks} task${counts.tasks === 1 ? "" : "s"}`);
    if (counts.events > 0)
      childParts.push(`${counts.events} event${counts.events === 1 ? "" : "s"}`);
    const childSuffix =
      childParts.length > 0 ? ` (${childParts.join(", ")})` : "";
    try {
      await contactRef.collection("activities").add({
        type: "contact_territory_changed",
        content: `Account moved from ${fromTerritoryName} to ${toTerritoryName}${childSuffix}.`,
        createdBy: access.uid,
        meta: {
          fromTerritoryId: fromTerritoryId ?? null,
          toTerritoryId: territoryId,
          movedDeals: counts.deals,
          movedQuotes: counts.quotes,
          movedTasks: counts.tasks,
          movedEvents: counts.events,
        },
        createdAt: stamp,
      });
    } catch (err) {
      console.warn("[territory-retag] activity write failed", err);
    }
  }

  return NextResponse.json({
    ok: true,
    contactId,
    territoryId,
    moved: counts,
  });
}
