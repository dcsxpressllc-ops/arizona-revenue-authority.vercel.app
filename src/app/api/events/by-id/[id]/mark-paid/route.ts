import "server-only";

import { NextResponse } from "next/server";

import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { markBookingPaidServerSide } from "@/lib/server/bookings-service";
import type { CalendarEvent } from "@/types/events";

/**
 * Operator "mark as paid" for an `awaiting_payment` booking. Any active member.
 * The transition lives in lib/server/bookings-service.ts so the Stripe
 * reconciler uses the exact same path for card deposits.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: eventId } = await ctx.params;

  // Need the event first to know which sub-account to auth against.
  const snap = await getAdminDb().collection("events").doc(eventId).get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Event not found" }, { status: 404 });
  }
  const event = snap.data() as CalendarEvent;

  const access = await requireSubAccountMember(request, event.subAccountId);
  if (access instanceof NextResponse) return access;

  const result = await markBookingPaidServerSide({
    eventId,
    expectSubAccountId: event.subAccountId,
    paidByUid: access.uid,
  });

  if (!result.ok) {
    const status =
      result.code === "not_found"
        ? 404
        : result.code === "wrong_tenant"
          ? 403
          : result.code === "write_failed"
            ? 500
            : 409;
    return NextResponse.json(
      { error: result.message, ...(result.status ? { status: result.status } : {}) },
      { status },
    );
  }

  return NextResponse.json({
    ok: true,
    status: result.status,
    publicEventUrl: result.publicEventUrl,
  });
}
