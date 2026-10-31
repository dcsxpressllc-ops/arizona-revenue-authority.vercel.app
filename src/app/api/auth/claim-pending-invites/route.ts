import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminAuth, getAdminDb } from "@/lib/firebase/admin";

/**
 * Attaches pending sub-account invites for the caller's email to their
 * existing account (signup 409s on existing emails, so it never gets here).
 * Idempotent. The email comes from the Firebase Auth record, not a header,
 * so it can't be spoofed. Returns `{ attached: [{ subAccountId, name }] }`.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const uid = request.headers.get("x-user-uid");
  if (!uid) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const auth = getAdminAuth();
  let userRecord;
  try {
    userRecord = await auth.getUser(uid);
  } catch {
    return NextResponse.json(
      { error: "User account not found" },
      { status: 404 },
    );
  }
  const email = userRecord.email?.toLowerCase().trim();
  if (!email) {
    return NextResponse.json(
      { error: "User account has no email" },
      { status: 400 },
    );
  }

  const db = getAdminDb();

  // Needs the (email, acceptedByUid, revokedAt) composite index; a missing
  // index error is surfaced rather than swallowed.
  const inviteSnaps = await db
    .collection("invites")
    .where("email", "==", email)
    .where("acceptedByUid", "==", null)
    .where("revokedAt", "==", null)
    .get();

  if (inviteSnaps.empty) {
    return NextResponse.json({ attached: [] });
  }

  const attached: Array<{ subAccountId: string; name: string }> = [];

  // One small batch per invite so a bad doc doesn't block the rest.
  for (const inviteDoc of inviteSnaps.docs) {
    const invite = inviteDoc.data() as {
      email: string;
      agencyId: string;
      subAccountId: string | null;
      subAccountRole: "admin" | "collaborator" | null;
      agencyRole: "owner" | "staff" | null;
      invitedByUid: string;
      requiresToken?: boolean;
    };
    if (!invite.subAccountId || !invite.subAccountRole) {
      // Agency-level invites aren't handled here.
      continue;
    }
    // Token-protected invites need a verified email (set by signup with a
    // valid invite link). Otherwise an account created through Firebase's
    // public signup with someone else's address would inherit their invites.
    if (invite.requiresToken === true && !userRecord.emailVerified) {
      continue;
    }

    // Membership may already exist (prior claim whose invite update failed);
    // still mark the invite accepted so it stops showing up.
    const memberRef = db.doc(
      `subAccounts/${invite.subAccountId}/subAccountMembers/${uid}`,
    );
    const memberSnap = await memberRef.get();

    const subSnap = await db.doc(`subAccounts/${invite.subAccountId}`).get();
    const subName = (subSnap.data()?.name as string) ?? "Sub-account";

    const batch = db.batch();

    if (!memberSnap.exists) {
      batch.set(memberRef, {
        uid,
        subAccountId: invite.subAccountId,
        agencyId: invite.agencyId,
        role: invite.subAccountRole,
        status: "active",
        email,
        displayName: userRecord.displayName ?? "",
        addedAt: FieldValue.serverTimestamp(),
        addedByUid: invite.invitedByUid,
      });

      batch.set(
        db.doc(`userMemberships/${uid}/subAccounts/${invite.subAccountId}`),
        {
          subAccountId: invite.subAccountId,
          agencyId: invite.agencyId,
          role: invite.subAccountRole,
          name: subName,
          addedAt: FieldValue.serverTimestamp(),
        },
      );

      attached.push({ subAccountId: invite.subAccountId, name: subName });
    }

    batch.update(inviteDoc.ref, {
      acceptedByUid: uid,
      acceptedAt: FieldValue.serverTimestamp(),
    });

    try {
      await batch.commit();
    } catch (err) {
      console.error(
        `[claim-pending-invites] commit failed for invite ${inviteDoc.id}`,
        err,
      );
      // Keep going; one bad invite doesn't fail the call.
    }
  }

  return NextResponse.json({ attached });
}
