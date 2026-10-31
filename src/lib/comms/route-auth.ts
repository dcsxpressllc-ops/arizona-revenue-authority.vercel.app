import "server-only";

import { NextResponse } from "next/server";
import { getAdminAuth, getAdminDb } from "@/lib/firebase/admin";
import type { Contact } from "@/types/contacts";

export function requireUid(request: Request):
  | { uid: string; email: string }
  | NextResponse {
  const uid = request.headers.get("x-user-uid");
  if (!uid) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const email = request.headers.get("x-user-email") ?? "";
  return { uid, email };
}

/**
 * Caller must be the owner of the contact's agency or an active member of its
 * sub-account. Returns the Contact, or an error response.
 */
export async function requireContactAccessible(
  uid: string,
  contactId: string,
): Promise<Contact | NextResponse> {
  if (!contactId) {
    return NextResponse.json(
      { error: "Missing contactId" },
      { status: 400 },
    );
  }
  const db = getAdminDb();
  const snap = await db.collection("contacts").doc(contactId).get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }
  const data = snap.data() as Omit<Contact, "id">;

  const callerRecord = await getAdminAuth().getUser(uid).catch(() => null);
  const claims = (callerRecord?.customClaims ?? {}) as {
    status?: "active" | "removed";
    agencyId?: string | null;
    agencyRole?: "owner" | "staff" | null;
  };
  if (claims.status !== "active") {
    return NextResponse.json({ error: "Account inactive" }, { status: 403 });
  }

  // Agency owners can reach every sub-account in their agency.
  if (claims.agencyRole === "owner" && claims.agencyId === data.agencyId) {
    return { id: snap.id, ...data };
  }

  const memberSnap = await db
    .doc(`subAccounts/${data.subAccountId}/subAccountMembers/${uid}`)
    .get();
  if (!memberSnap.exists) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const member = memberSnap.data() ?? {};
  if (member.status !== "active") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return { id: snap.id, ...data };
}
