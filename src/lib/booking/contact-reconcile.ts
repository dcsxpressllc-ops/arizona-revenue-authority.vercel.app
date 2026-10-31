import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { normalizePhoneLenient } from "@/lib/contacts/phone";
import { emitContactCreatedById } from "@/lib/server/contacts-service";
import { GLOBAL_TERRITORY_ID } from "@/types";
import type { Contact } from "@/types/contacts";

/**
 * Match a booking visitor to a Contact by email (same strategy as the web-chat
 * capture in comms/ai/capture.ts), creating one if needed. Booking intake always
 * collects an email, so there's always a key.
 *
 * Throws on Firestore errors so the route can 500 before charging or emailing.
 */

interface ReconcileInput {
  agencyId: string;
  subAccountId: string;
  /** Lower-cased and trimmed by the caller. */
  email: string;
  /** May be empty. */
  name: string;
  /** May be empty. */
  phone: string;
  /** Workspace default for lenient E.164 normalization. Absent = "US". */
  phoneCountry?: string | null;
  /**
   * Territory for new contacts; null falls back to the inbound-lead Global
   * default. Existing contacts' territory is never touched here.
   */
  defaultTerritoryId?: string | null;
}

export interface ReconciledContact {
  id: string;
  created: boolean;
}

export async function reconcileBookingContact(
  input: ReconcileInput,
): Promise<ReconciledContact> {
  const db = getAdminDb();
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();
  // Lenient: a booking must never fail over a phone format.
  const phone = normalizePhoneLenient(input.phone, input.phoneCountry);

  const existing = await db
    .collection("contacts")
    .where("subAccountId", "==", input.subAccountId)
    .where("email", "==", email)
    .limit(1)
    .get();

  if (!existing.empty) {
    const doc = existing.docs[0];
    const data = doc.data() as Contact;
    // Only fill missing name/phone; never overwrite what the operator curated.
    const patch: Record<string, unknown> = {};
    if (name && !data.name) patch.name = name;
    if (phone && !data.phone) patch.phone = phone;
    if (Object.keys(patch).length > 0) {
      patch.updatedAt = FieldValue.serverTimestamp();
      try {
        await doc.ref.update(patch);
      } catch {
        // Non-fatal; the booking still goes through.
      }
    }
    return { id: doc.id, created: false };
  }

  // `source: "booking-page"` so the contact badge can tell it apart from forms and web chat.
  const territoryId =
    typeof input.defaultTerritoryId === "string" &&
    input.defaultTerritoryId.length > 0
      ? input.defaultTerritoryId
      : GLOBAL_TERRITORY_ID;
  const ref = await db.collection("contacts").add({
    name,
    email,
    phone,
    company: "",
    address: "",
    source: "booking-page",
    tags: [],
    pipelineStage: null,
    attribution: null,
    agencyId: input.agencyId,
    subAccountId: input.subAccountId,
    // Same system sentinel the form-submit and web-chat routes use.
    createdByUid: "booking-page",
    emailOptedOut: false,
    smsOptedOut: false,
    countryCode: null,
    country: null,
    city: null,
    lat: null,
    lng: null,
    territoryId,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  void emitContactCreatedById({
    subAccountId: input.subAccountId,
    agencyId: input.agencyId,
    contactId: ref.id,
  });

  return { id: ref.id, created: true };
}
