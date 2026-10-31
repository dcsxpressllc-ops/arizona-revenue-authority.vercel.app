import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import {
  canTakePayment,
  NO_PAYMENT_RAIL_MESSAGE,
} from "@/lib/payments/can-take-payment";
import { validateBookingPageFormData } from "@/lib/booking/validation";
import { resolveBookingHosts } from "@/lib/booking/hosts";
import { GLOBAL_TERRITORY_ID } from "@/types";

/**
 * Booking page creation, shared by the editor's create route and the AI
 * Suite's create_booking_page so both apply the same validation, payment
 * check, host resolution and slug uniqueness. Writes only under the given
 * sub-account.
 */

export type CreateBookingPageResult =
  | { ok: true; slug: string }
  | { ok: false; status: 400 | 404 | 409 | 500; error: string };

export async function createBookingPageForSubAccount(input: {
  subAccountId: string;
  /** The admin creating it; owns the page's Google Calendar push. */
  uid: string;
  body: unknown;
}): Promise<CreateBookingPageResult> {
  const { subAccountId } = input;
  const validated = validateBookingPageFormData(input.body);
  if (!validated.ok) return { ok: false, status: 400, error: validated.error };
  const data = validated.value;

  const db = getAdminDb();
  const subSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  if (!subSnap.exists) return { ok: false, status: 404, error: "Sub-account not found" };
  const sub = subSnap.data() ?? {};
  const agencyId = (sub.agencyId as string | undefined) ?? null;
  if (!agencyId) {
    return { ok: false, status: 500, error: "Sub-account is missing tenancy metadata." };
  }

  // No payment rail means the Pay button would go nowhere.
  if (data.payment && !canTakePayment(sub)) {
    return {
      ok: false,
      status: 400,
      error: `${NO_PAYMENT_RAIL_MESSAGE} A booking page can't require a deposit until then.`,
    };
  }

  // Global by default so the no-unassigned invariant holds with scoping off.
  const territoryId =
    data.defaultTerritoryId && data.defaultTerritoryId !== GLOBAL_TERRITORY_ID
      ? data.defaultTerritoryId
      : GLOBAL_TERRITORY_ID;

  // Active members only, names re-snapshotted (don't trust client names).
  const hosts = await resolveBookingHosts(subAccountId, data.hosts);

  // Doc id == slug, so create() is the uniqueness check.
  const ref = db.doc(`subAccounts/${subAccountId}/bookingPages/${data.slug}`);
  const now = FieldValue.serverTimestamp();
  try {
    await ref.create({
      ...data,
      hosts,
      id: data.slug,
      agencyId,
      subAccountId,
      createdByUid: input.uid,
      territoryId,
      createdAt: now,
      updatedAt: now,
    });
  } catch (err) {
    const code =
      typeof err === "object" && err !== null && "code" in err
        ? (err as { code?: number | string }).code
        : null;
    if (code === 6 || code === "already-exists") {
      return {
        ok: false,
        status: 409,
        error: `A booking page with the slug "${data.slug}" already exists. Pick another.`,
      };
    }
    throw err;
  }
  return { ok: true, slug: data.slug };
}
