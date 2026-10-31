import { NextResponse } from "next/server";

import { getAdminDb } from "@/lib/firebase/admin";
import {
  listSellableProducts,
  toGitpageProducts,
} from "@/lib/server/products-catalog-service";
import { sellOnlineReady } from "@/lib/products/sell-online";
import type { SubAccountDoc } from "@/types/tenancy";

export const dynamic = "force-dynamic";

/**
 * Public, read-only catalog of what a sub-account sells online, in the same
 * shape the website build receives. Used by gitpage's resync and its MCP
 * list_products tool. Public catalog data only, so no auth; 404 whenever
 * selling is off so the feed never confirms a workspace exists.
 */

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "public, max-age=60, s-maxage=60",
};

export function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: { ...HEADERS, "Access-Control-Allow-Methods": "GET, OPTIONS" },
  });
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ subAccountId: string }> },
) {
  const { subAccountId } = await ctx.params;
  const notFound = () =>
    NextResponse.json({ error: "Not found" }, { status: 404, headers: HEADERS });
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(subAccountId)) return notFound();

  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  if (!snap.exists) return notFound();
  const sub = snap.data() as Partial<SubAccountDoc>;
  if (!sellOnlineReady(sub)) return notFound();

  // Builds send the redirect-resolved app URL, and gitpage checks every
  // buyUrl starts with it. This request arrived at that final host, so its
  // origin matches; the env value is only the fallback.
  const origin = new URL(request.url).origin;
  const appUrl = /^https:\/\/[^\s/]+$/i.test(origin)
    ? origin
    : (process.env.NEXT_PUBLIC_APP_URL ?? "").trim().replace(/\/$/, "");
  if (!/^https:\/\/[^\s/]+$/i.test(appUrl)) return notFound();
  const products = await listSellableProducts(subAccountId, sub);
  return NextResponse.json(
    {
      products: await toGitpageProducts(subAccountId, products, appUrl),
      // Every id still for sale, past the cap too, so a resync only removes
      // pages of products that are really gone.
      ids: products.map((p) => p.id),
    },
    { headers: HEADERS },
  );
}
