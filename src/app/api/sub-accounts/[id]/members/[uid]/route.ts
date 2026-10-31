import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminAuth, getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { removeCalendarConnection } from "@/lib/google/calendar-import";

/**
 * PATCH: change role (admin <-> collaborator). DELETE: remove from the
 * sub-account (membership "removed", switcher index entry deleted). If no
 * active memberships remain, the user is also marked removed globally and
 * their Firebase Auth user disabled; AuthContext signs them out on next load.
 * Caller: agency owner or sub-account admin.
 */
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string; uid: string }> },
) {
  const { id: subAccountId, uid: targetUid } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: {
    role?: "admin" | "collaborator";
    assignedTerritoryIds?: string[];
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const db = getAdminDb();
  const memberRef = db.doc(
    `subAccounts/${subAccountId}/subAccountMembers/${targetUid}`,
  );
  const memberSnap = await memberRef.get();
  if (!memberSnap.exists) {
    return NextResponse.json({ error: "Not a member" }, { status: 404 });
  }

  const indexRef = db.doc(
    `userMemberships/${targetUid}/subAccounts/${subAccountId}`,
  );

  const memberPatch: Record<string, unknown> = {};
  const indexPatch: Record<string, unknown> = {};

  if (body.role === "admin" || body.role === "collaborator") {
    memberPatch.role = body.role;
    indexPatch.role = body.role;
  }

  if (Array.isArray(body.assignedTerritoryIds)) {
    // Cap at 30: the scoped list queries use Firestore `in`, which takes at
    // most 30 values, so extra territories would silently vanish for the rep.
    const ids = [...new Set(body.assignedTerritoryIds.filter((x) => typeof x === "string"))];
    if (ids.length > 30) {
      return NextResponse.json(
        {
          error:
            "A member can be assigned at most 30 territories (query limit). Split coverage across reps if you need more.",
        },
        { status: 400 },
      );
    }
    if (ids.length > 0) {
      const refs = ids.map((id) =>
        db.doc(`subAccounts/${subAccountId}/territories/${id}`),
      );
      const snaps = await db.getAll(...refs);
      const missing = snaps.find(
        (s) =>
          !s.exists ||
          (s.data()?.status as string | undefined) !== "active",
      );
      if (missing) {
        return NextResponse.json(
          {
            error:
              "One or more territories don't exist or are archived. Refresh and try again.",
          },
          { status: 400 },
        );
      }
    }
    memberPatch.assignedTerritoryIds = ids;
  }

  if (Object.keys(memberPatch).length === 0) {
    return NextResponse.json(
      { error: "Nothing to update." },
      { status: 400 },
    );
  }

  const batch = db.batch();
  batch.update(memberRef, memberPatch);
  if (Object.keys(indexPatch).length > 0) {
    batch.update(indexRef, indexPatch);
  }
  await batch.commit();

  return NextResponse.json({
    ok: true,
    uid: targetUid,
    role: memberPatch.role,
    assignedTerritoryIds: memberPatch.assignedTerritoryIds,
  });
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string; uid: string }> },
) {
  const { id: subAccountId, uid: targetUid } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  if (targetUid === access.uid) {
    return NextResponse.json(
      { error: "You can't remove yourself. Ask the agency owner." },
      { status: 400 },
    );
  }

  const db = getAdminDb();
  const memberRef = db.doc(
    `subAccounts/${subAccountId}/subAccountMembers/${targetUid}`,
  );
  const memberSnap = await memberRef.get();
  if (!memberSnap.exists) {
    return NextResponse.json({ error: "Not a member" }, { status: 404 });
  }

  // Mark the membership removed and drop the index entry.
  const batch = db.batch();
  batch.update(memberRef, {
    status: "removed",
    removedAt: FieldValue.serverTimestamp(),
  });
  batch.delete(
    db.doc(`userMemberships/${targetUid}/subAccounts/${subAccountId}`),
  );
  await batch.commit();

  // Their Google Calendar connection and imported events leave with them.
  try {
    // No revoke: their Google grant may still serve them in other workspaces.
    await removeCalendarConnection(subAccountId, targetUid, { revoke: false });
  } catch (err) {
    console.error(`[members/DELETE] calendar cleanup failed for ${targetUid}`, err);
  }

  // Drop their notification pref for this sub-account. Cleanup only; the send
  // helper re-checks membership anyway.
  void db
    .doc(`users/${targetUid}/settings/notifications`)
    .set(
      { subAccounts: { [subAccountId]: FieldValue.delete() } },
      { merge: true },
    )
    .catch(() => {});

  // No active memberships and no agency role left: disable globally.
  // Best-effort, because the removal above already committed and the admin
  // shouldn't see "could not remove" for something that worked.
  let globallyRemoved = false;
  try {
    const remaining = await db
      .collectionGroup("subAccountMembers")
      .where("uid", "==", targetUid)
      .where("status", "==", "active")
      .limit(1)
      .get();

    if (remaining.empty) {
      const userSnap = await db.doc(`users/${targetUid}`).get();
      const userData = userSnap.data() ?? {};
      const agencyId = userData.primaryAgencyId as string | null | undefined;

      let isAgencyOwner = false;
      if (agencyId) {
        const ownerSnap = await db
          .doc(`agencies/${agencyId}/agencyMembers/${targetUid}`)
          .get();
        const ownerData = ownerSnap.data() ?? {};
        isAgencyOwner =
          ownerData.role === "owner" && ownerData.status === "active";
      }

      if (!isAgencyOwner) {
        // set(merge), not update(): directly-added members may have no users/{uid}
        // doc, and update() would throw NOT_FOUND.
        await db.doc(`users/${targetUid}`).set(
          {
            status: "removed",
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
        const auth = getAdminAuth();
        const existing = await auth.getUser(targetUid).catch(() => null);
        const claims = (existing?.customClaims ?? {}) as Record<string, unknown>;
        await auth.setCustomUserClaims(targetUid, {
          ...claims,
          status: "removed",
        });
        await auth
          .updateUser(targetUid, { disabled: true })
          .catch(() => undefined);
        globallyRemoved = true;
      }
    }
  } catch (err) {
    // Already removed; log and report success anyway.
    console.error(
      `[members/DELETE] post-removal global-disable failed for ${targetUid} — member already removed`,
      err,
    );
  }

  return NextResponse.json({ ok: true, uid: targetUid, globallyRemoved });
}
