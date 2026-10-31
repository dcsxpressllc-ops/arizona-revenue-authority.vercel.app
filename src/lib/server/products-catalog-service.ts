import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import {
  expressBuyPath,
  isSellableProduct,
  productKind,
  sellOnlineReady,
} from "@/lib/products/sell-online";
import type { GitpageProduct } from "@/lib/gitpage/client";
import type { Product } from "@/types/products";
import type { SubAccountDoc } from "@/types/tenancy";

/**
 * The public catalog of a sub-account: what its website may show and the
 * public feed returns. One builder for both so the site and the feed never
 * disagree. Public fields only; never cost data or internal notes.
 */

/** gitpage accepts at most this many per build. */
export const MAX_SITE_PRODUCTS = 24;

export function productsFeedPath(subAccountId: string): string {
  return `/api/products-feed/${subAccountId}`;
}

export async function listSellableProducts(
  subAccountId: string,
  sub: Partial<SubAccountDoc>,
): Promise<Product[]> {
  if (!sellOnlineReady(sub)) return [];
  const snap = await getAdminDb()
    .collection("products")
    .where("subAccountId", "==", subAccountId)
    .where("sellOnline", "==", true)
    .get();
  return snap.docs
    .map((d) => ({ id: d.id, ...(d.data() as Omit<Product, "id">) }))
    .filter((p) => isSellableProduct(p) && p.unitPriceCents > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Slugs of published checkout pages that products route their Buy button to. */
async function checkoutPageSlugs(
  subAccountId: string,
  products: Product[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const db = getAdminDb();
  await Promise.all(
    products
      .filter((p) => p.checkoutPageId)
      .map(async (p) => {
        const page = await db
          .doc(`subAccounts/${subAccountId}/checkoutPages/${p.checkoutPageId}`)
          .get();
        const data = page.data();
        if (page.exists && data?.status === "published" && data.productId === p.id && typeof data.slug === "string") {
          out.set(p.id, data.slug);
        }
      }),
  );
  return out;
}

export async function toGitpageProducts(
  subAccountId: string,
  products: Product[],
  appUrl: string,
): Promise<GitpageProduct[]> {
  const base = appUrl.replace(/\/$/, "");
  const pageSlugs = await checkoutPageSlugs(subAccountId, products);
  return products.slice(0, MAX_SITE_PRODUCTS).map((p) => {
    const pageSlug = pageSlugs.get(p.id);
    return {
      id: p.id,
      slug: p.slug!,
      name: p.name.slice(0, 120),
      description: (p.publicDescription || p.description || "").slice(0, 2_000),
      priceCents: p.unitPriceCents,
      currency: (p.currency || "USD").toLowerCase(),
      images: (p.images ?? []).slice(0, 6).map((img) => ({
        url: img.url,
        alt: (img.alt || p.name).slice(0, 200),
        ...(img.width && img.height ? { width: img.width, height: img.height } : {}),
      })),
      kind: productKind(p.delivery),
      buyUrl: pageSlug
        ? `${base}/co/${subAccountId}/${pageSlug}`
        : `${base}${expressBuyPath(subAccountId, p.slug!)}`,
      version: p.publicVersion ?? 0,
    };
  });
}
