import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  requireSubAccountAdmin,
  requireSubAccountMember,
} from "@/lib/auth/require-tenancy";
import { createBookingPageForSubAccount } from "@/lib/server/booking-pages-service";
import type { BookingPage } from "@/types/booking";

/**
 * GET: list booking pages (any active member, so collaborators can share
 * links). Clients mostly read via the SDK; this is for server renderers and
 * tests. POST: create (admin only), via booking-pages-service so the AI
 * Suite creates pages the same way. The slug is the doc id, so create()
 * detects collisions.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const snap = await getAdminDb()
    .collection(`subAccounts/${subAccountId}/bookingPages`)
    .get();
  const pages = snap.docs
    .map((d) => ({ id: d.id, ...(d.data() as Omit<BookingPage, "id">) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return NextResponse.json({ ok: true, pages });
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const result = await createBookingPageForSubAccount({
    subAccountId,
    uid: access.uid,
    body,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true, slug: result.slug });
}
