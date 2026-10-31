import "server-only";
import {
  canTakePayment,
  NO_PAYMENT_RAIL_MESSAGE,
} from "@/lib/payments/can-take-payment";
import type { SubAccountDoc } from "@/types/tenancy";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  requireSubAccountAdmin,
  requireSubAccountMember,
} from "@/lib/auth/require-tenancy";
import { validateBookingPageFormData } from "@/lib/booking/validation";
import { resolveBookingHosts } from "@/lib/booking/hosts";
import { GLOBAL_TERRITORY_ID } from "@/types";
import type { BookingPage } from "@/types/booking";

/**
 * GET: read (members). PATCH: full replace of editable fields, admin only,
 * same validator as create. The slug is immutable; the URL param wins.
 * DELETE: admin only, blocked while future events reference the slug, or
 * their reschedule/cancel links would break.
 */

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string; slug: string }> },
) {
  const { id: subAccountId, slug } = await ctx.params;
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const snap = await getAdminDb()
    .doc(`subAccounts/${subAccountId}/bookingPages/${slug}`)
    .get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Booking page not found" }, { status: 404 });
  }
  return NextResponse.json({
    ok: true,
    page: { id: snap.id, ...(snap.data() as Omit<BookingPage, "id">) },
  });
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string; slug: string }> },
) {
  const { id: subAccountId, slug } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Renaming the slug would orphan public links and the /e/[token] pages.
  const bodyWithSlug =
    typeof body === "object" && body !== null
      ? { ...(body as Record<string, unknown>), slug }
      : { slug };

  const validated = validateBookingPageFormData(bodyWithSlug);
  if (!validated.ok) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }
  const data = validated.value;

  const db = getAdminDb();
  const ref = db.doc(`subAccounts/${subAccountId}/bookingPages/${slug}`);
  const snap = await ref.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Booking page not found" }, { status: 404 });
  }

  // Same payment gate as create.
  if (data.payment) {
    const subSnap = await db.doc(`subAccounts/${subAccountId}`).get();
    if (!canTakePayment(subSnap.data() as SubAccountDoc | undefined)) {
      return NextResponse.json(
        {
          error:
            `${NO_PAYMENT_RAIL_MESSAGE} A booking page can't require a deposit until then.`,
        },
        { status: 400 },
      );
    }
  }

  // Active members only, fresh name snapshot (same as create).
  const hosts = await resolveBookingHosts(subAccountId, data.hosts);

  // territoryId isn't edited here (that's the retag route).
  // defaultTerritoryId is a per-page setting and is editable.
  const patch = {
    ...data,
    hosts,
    territoryId: snap.data()?.territoryId ?? GLOBAL_TERRITORY_ID,
    updatedAt: FieldValue.serverTimestamp(),
  };
  await ref.update(patch);
  return NextResponse.json({ ok: true, slug });
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string; slug: string }> },
) {
  const { id: subAccountId, slug } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const db = getAdminDb();
  const ref = db.doc(`subAccounts/${subAccountId}/bookingPages/${slug}`);
  const snap = await ref.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Booking page not found" }, { status: 404 });
  }

  // Two equality filters, then count future events in memory (same as
  // subscribeToBookingPageEvents). An inequality on startAt would need the
  // events(subAccountId, bookingPageSlug, startAt) index and throws
  // FAILED_PRECONDITION if it isn't built. Bookings per page are bounded.
  const nowMs = Date.now();
  let futureCount: number;
  try {
    const eventsSnap = await db
      .collection("events")
      .where("subAccountId", "==", subAccountId)
      .where("bookingPageSlug", "==", slug)
      .get();
    futureCount = eventsSnap.docs.filter((doc) => {
      const startAt = doc.get("startAt") as { toMillis?: () => number } | null;
      const ms = startAt?.toMillis?.();
      return typeof ms === "number" && ms >= nowMs;
    }).length;
  } catch (err) {
    console.error(
      `[booking-pages/delete] future-bookings check failed sa=${subAccountId} slug=${slug}`,
      err,
    );
    return NextResponse.json(
      { error: "Couldn't verify upcoming bookings. Please try again." },
      { status: 500 },
    );
  }
  if (futureCount > 0) {
    return NextResponse.json(
      {
        error: `Can't delete: ${futureCount} upcoming booking${
          futureCount === 1 ? "" : "s"
        } still use this page. Cancel them first, or unpublish the page to stop new bookings.`,
        futureCount,
      },
      { status: 409 },
    );
  }

  await ref.delete();
  return NextResponse.json({ ok: true, slug });
}
