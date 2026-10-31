import "server-only";
import { canTakePayment } from "@/lib/payments/can-take-payment";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import {
  validateBookingPageFormData,
  validateSlug,
} from "@/lib/booking/validation";
import { resolveBookingHosts } from "@/lib/booking/hosts";
import { effectiveBookingLocation } from "@/lib/booking/location";
import { GLOBAL_TERRITORY_ID } from "@/types";
import type { BookingPage, BookingPageFormData } from "@/types/booking";

/**
 * POST: duplicate a booking page into a new draft in the same sub-account
 * (admin only). Config copies over; the clone gets a fresh unique slug, a
 * "Copy of ..." name, draft status, fresh tenancy stamps and createdByUid.
 * Past bookings are untouched.
 *
 * Same invariants as create (slug = doc id via create(), hosts re-resolved,
 * territoryId landed). One difference: if the source has a payment gate but
 * PayPal is no longer connected, the clone drops it and returns a `warning`
 * instead of a 400.
 */

/** Matches validateName; leaves room for the prefix. */
const NAME_MAX = 80;
const COPY_PREFIX = "Copy of ";
/** Matches validateSlug. */
const SLUG_MAX = 48;
/** Collision retries before falling back to a random suffix. */
const MAX_SLUG_ATTEMPTS = 25;

function copyName(sourceName: string): string {
  const room = NAME_MAX - COPY_PREFIX.length;
  return COPY_PREFIX + sourceName.slice(0, room).trim();
}

/**
 * "{base}-copy", "{base}-copy-2", ... Base is truncated and stripped of
 * trailing hyphens so the result always passes validateSlug.
 */
function copySlugCandidate(sourceSlug: string, attempt: number): string {
  const suffix = attempt <= 1 ? "-copy" : `-copy-${attempt}`;
  const base = sourceSlug
    .slice(0, SLUG_MAX - suffix.length)
    .replace(/-+$/, "");
  return `${base}${suffix}`;
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string; slug: string }> },
) {
  const { id: subAccountId, slug } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const db = getAdminDb();

  const sourceSnap = await db
    .doc(`subAccounts/${subAccountId}/bookingPages/${slug}`)
    .get();
  if (!sourceSnap.exists) {
    return NextResponse.json(
      { error: "Booking page not found" },
      { status: 404 },
    );
  }
  const source = sourceSnap.data() as Omit<BookingPage, "id">;

  const subSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  if (!subSnap.exists) {
    return NextResponse.json(
      { error: "Sub-account not found" },
      { status: 404 },
    );
  }
  const sub = subSnap.data() ?? {};
  const agencyId = (sub.agencyId as string | undefined) ?? null;
  if (!agencyId) {
    return NextResponse.json(
      { error: "Sub-account is missing tenancy metadata." },
      { status: 500 },
    );
  }

  // Copy every editable field, then swap identity: new name, draft status
  // (slug is set per attempt below).
  let warning: string | null = null;
  let payment = source.payment ?? null;
  if (payment && !canTakePayment(sub)) {
    // Payment rail is gone; drop the gate and tell the operator to re-add it.
    payment = null;
    warning =
      "Payment was removed from the copy — connect Stripe or PayPal under Settings → Payments, then re-enable it on the new page.";
  }

  const draft: BookingPageFormData = {
    slug: copySlugCandidate(slug, 1), // replaced per attempt
    name: copyName(source.name),
    description: source.description ?? "",
    status: "draft",
    durationMinutes: source.durationMinutes,
    bufferMinutes: source.bufferMinutes,
    workingHours: source.workingHours,
    timezone: source.timezone,
    visibleDays: source.visibleDays,
    minNoticeHours: source.minNoticeHours,
    maxPerDay: source.maxPerDay,
    intakeFields: source.intakeFields ?? [],
    hosts: source.hosts ?? [],
    logoUrl: source.logoUrl ?? null,
    accentColor: source.accentColor ?? null,
    themePreset: source.themePreset ?? null,
    meetingUrl: source.meetingUrl ?? null,
    googleMeet: source.googleMeet ?? false,
    location: effectiveBookingLocation(source),
    confirmationMessage: source.confirmationMessage ?? "",
    redirectUrl: source.redirectUrl ?? null,
    redirectAppendParams: source.redirectAppendParams ?? true,
    remindersEnabled: source.remindersEnabled,
    smsRemindersEnabled: source.smsRemindersEnabled ?? false,
    reminderOffsetsMinutes: source.reminderOffsetsMinutes,
    payment,
    defaultTerritoryId: source.defaultTerritoryId ?? null,
  };

  // Full validator so the clone is normalized exactly like a created page;
  // older docs may predate a bound.
  const validated = validateBookingPageFormData(draft);
  if (!validated.ok) {
    return NextResponse.json(
      { error: `Couldn't duplicate this page: ${validated.error}` },
      { status: 400 },
    );
  }
  const data = validated.value;

  // Drop removed members and refresh name snapshots, as create/update do.
  const hosts = await resolveBookingHosts(subAccountId, data.hosts);

  // Same derivation as the create route.
  const territoryId =
    data.defaultTerritoryId && data.defaultTerritoryId !== GLOBAL_TERRITORY_ID
      ? data.defaultTerritoryId
      : GLOBAL_TERRITORY_ID;

  // Write under a fresh unique slug (atomic create, retry on collision).
  const now = FieldValue.serverTimestamp();
  for (let attempt = 1; attempt <= MAX_SLUG_ATTEMPTS; attempt++) {
    const candidate =
      attempt < MAX_SLUG_ATTEMPTS
        ? copySlugCandidate(slug, attempt)
        : `${copySlugCandidate(slug, 1)}-${access.uid.slice(0, 6).toLowerCase()}`;

    const slugCheck = validateSlug(candidate);
    if (!slugCheck.ok) continue; // shouldn't happen
    const newSlug = slugCheck.value;

    const ref = db.doc(`subAccounts/${subAccountId}/bookingPages/${newSlug}`);
    try {
      await ref.create({
        ...data,
        slug: newSlug,
        hosts,
        id: newSlug,
        agencyId,
        subAccountId,
        createdByUid: access.uid,
        territoryId,
        createdAt: now,
        updatedAt: now,
      });
      return NextResponse.json({ ok: true, slug: newSlug, warning });
    } catch (err) {
      const code =
        typeof err === "object" && err !== null && "code" in err
          ? (err as { code?: number | string }).code
          : null;
      // ALREADY_EXISTS: try the next slug. Anything else rethrows.
      if (code === 6 || code === "already-exists") continue;
      throw err;
    }
  }

  return NextResponse.json(
    {
      error:
        "Couldn't find an available slug for the copy. Edit the original's slug or try again.",
    },
    { status: 409 },
  );
}
