import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { createContactServerSide } from "@/lib/server/contacts-service";
import type { Member } from "@/types/community";

/** One identity per email per sub-account. Queried rather than keyed by email so an email change doesn't orphan the doc. */
export async function findMemberByEmail(
  subAccountId: string,
  email: string,
): Promise<Member | null> {
  const snap = await getAdminDb()
    .collection(`subAccounts/${subAccountId}/members`)
    .where("email", "==", email.trim().toLowerCase())
    .limit(1)
    .get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...(doc.data() as Omit<Member, "id">) };
}

interface EnsureMemberInput {
  subAccountId: string;
  email: string;
  displayName?: string | null;
}

/**
 * Get-or-create the member for `email`, linking a CRM contact (joining doubles
 * as lead capture). Called at magic-link verify, never at request, so members
 * only exist for emails whose owner clicked the link. Reuses a contact matched
 * by email or creates one (`source: "community"`) through the normal server
 * path so `contact.created` fires.
 *
 * Two concurrent verifies for a new email could create two docs; the
 * short-lived link makes that unlikely. No transactional guard yet.
 */
export async function ensureMember({
  subAccountId,
  email,
  displayName,
}: EnsureMemberInput): Promise<Member> {
  const db = getAdminDb();
  const normalizedEmail = email.trim().toLowerCase();

  const existing = await findMemberByEmail(subAccountId, normalizedEmail);
  if (existing) return existing;

  // Tenancy + audit actor for the contact.
  const saSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  if (!saSnap.exists) {
    throw new Error(`Sub-account ${subAccountId} not found`);
  }
  const sa = saSnap.data()!;
  const agencyId = (sa.agencyId as string) ?? "";
  const ownerUid = (sa.createdByUid as string) ?? "";

  let contactId: string | null = null;
  try {
    const contactSnap = await db
      .collection("contacts")
      .where("subAccountId", "==", subAccountId)
      .where("email", "==", normalizedEmail)
      .limit(1)
      .get();
    if (!contactSnap.empty) {
      contactId = contactSnap.docs[0].id;
    } else {
      const result = await createContactServerSide({
        subAccountId,
        agencyId,
        createdByUid: ownerUid,
        mode: "live",
        name: displayName?.trim() || "",
        email: normalizedEmail,
        phone: "",
        company: "",
        address: "",
        source: "community",
        tags: [],
      });
      contactId = result.id;
    }
  } catch (err) {
    // Don't block sign-in over this; the contact link can be repaired later, a failed login can't.
    console.warn("[community/member-account] contact reconcile failed", err);
  }

  const docRef = await db
    .collection(`subAccounts/${subAccountId}/members`)
    .add({
      subAccountId,
      agencyId,
      email: normalizedEmail,
      displayName: displayName?.trim() || null,
      avatarUrl: null,
      bio: "",
      contactId,
      status: "active",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      lastSeenAt: FieldValue.serverTimestamp(),
    });

  const snap = await docRef.get();
  return { id: docRef.id, ...(snap.data() as Omit<Member, "id">) };
}
