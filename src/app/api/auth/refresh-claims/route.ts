import "server-only";

import { NextResponse } from "next/server";
import { getAdminAuth, getAdminDb } from "@/lib/firebase/admin";

/**
 * Re-mints custom claims from Firestore after a membership change, so the
 * JWT updates without waiting for the hourly token refresh. Sources:
 * users/{uid}.status, users/{uid}.primaryAgencyId and the agencyMembers role.
 * Per-sub-account memberships stay off the JWT (size cap); rules get() them.
 */
export async function POST(request: Request) {
  const uid = request.headers.get("x-user-uid");
  if (!uid) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const db = getAdminDb();
  const auth = getAdminAuth();

  const userSnap = await db.doc(`users/${uid}`).get();
  if (!userSnap.exists) {
    return NextResponse.json({ error: "No user record" }, { status: 404 });
  }
  const user = userSnap.data() ?? {};
  const status = user.status === "removed" ? "removed" : "active";
  const agencyId = (user.primaryAgencyId as string | null) ?? null;

  let agencyRole: "owner" | "staff" | null = null;
  if (agencyId) {
    const memberSnap = await db
      .doc(`agencies/${agencyId}/agencyMembers/${uid}`)
      .get();
    if (memberSnap.exists) {
      const role = memberSnap.data()?.role;
      if (role === "owner" || role === "staff") {
        agencyRole = role;
      }
    }
  }

  // Legacy "role" claim, still read by some dashboard pages.
  const legacyRole =
    agencyRole === "owner"
      ? "admin"
      : ((user.role as "admin" | "collaborator" | undefined) ?? "collaborator");

  await auth.setCustomUserClaims(uid, {
    role: legacyRole,
    status,
    agencyId,
    agencyRole,
  });

  return NextResponse.json({
    ok: true,
    claims: { role: legacyRole, status, agencyId, agencyRole },
  });
}
