import "server-only";

import { NextResponse } from "next/server";

import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import {
  searchStockImages,
  stockImagesConfigured,
  stockSearchLink,
} from "@/lib/funnels/stock-images";

export const dynamic = "force-dynamic";

/**
 * Stock photo search for the funnel section image picker. Admin + Labs.
 * Proxied so the provider key stays server-side. With no key configured it
 * returns 200 with an empty list and a manual search link.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const subSnap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  if (subSnap.data()?.labsEnabledByAgency !== true) {
    return NextResponse.json(
      { error: "Labs isn't enabled for this workspace." },
      { status: 403 },
    );
  }

  const query = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  if (!query) {
    return NextResponse.json({ ok: true, images: [], configured: stockImagesConfigured() });
  }

  const images = await searchStockImages(query, 6);
  return NextResponse.json({
    ok: true,
    images,
    configured: stockImagesConfigured(),
    searchLink: stockSearchLink(query),
  });
}
