import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { emailIsConfigured } from "@/lib/comms/resend";
import { isSellableProduct, sellOnlineReady } from "@/lib/products/sell-online";
import { siteAddress, type WebsiteDoc } from "@/types/website";
import type { OrderDeliverySnapshot, OrderWebsiteRef } from "@/types/orders";
import type { Product } from "@/types/products";
import type { SubAccountDoc } from "@/types/tenancy";

/**
 * Shared by the express buy page, its session route and its thanks page
 * (/co/[subAccountId]/buy/[slug]). Everything about money and links is read
 * from Firestore; the browser only ever supplies the display-only websiteRef.
 */

export interface BuyBrand {
  name: string;
  logoUrl: string | null;
  accent: string;
}

export interface BuyContext {
  sub: Partial<SubAccountDoc>;
  agencyId: string;
  product: Product;
  brand: BuyBrand;
  /** Set when the product's Buy button goes to a published checkout page. */
  checkoutPageSlug: string | null;
}

const DEFAULT_ACCENT = "#4f46e5";
const HEX = /^#[0-9a-f]{6}$/i;

async function loadBrand(
  subAccountId: string,
  sub: Partial<SubAccountDoc>,
): Promise<BuyBrand> {
  let accent = DEFAULT_ACCENT;
  try {
    // Seeded from the website's primary colour at publish, so the buy page
    // matches the site the buyer just left.
    const chat = await getAdminDb()
      .doc(`subAccounts/${subAccountId}/aiAgent/web-chat`)
      .get();
    const c = chat.data()?.webChat?.accentColor;
    if (typeof c === "string" && HEX.test(c)) accent = c;
  } catch {
    // Cosmetic only.
  }
  const logo = typeof sub.logoUrl === "string" && sub.logoUrl.startsWith("https://")
    ? sub.logoUrl
    : null;
  return { name: sub.name || "Checkout", logoUrl: logo, accent };
}

/** Null = not for sale right now (the caller shows a friendly page). */
export async function loadBuyContext(
  subAccountId: string,
  slug: string,
): Promise<BuyContext | null> {
  if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(slug)) return null;
  const db = getAdminDb();
  const subSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  if (!subSnap.exists) return null;
  const sub = subSnap.data() as Partial<SubAccountDoc>;
  if (!sellOnlineReady(sub) || !sub.agencyId) return null;
  // Every buyer must get a confirmation email, so no sales without email.
  if (!emailIsConfigured()) return null;

  const snap = await db
    .collection("products")
    .where("subAccountId", "==", subAccountId)
    .where("slug", "==", slug)
    .limit(1)
    .get();
  if (snap.empty) return null;
  const product = { id: snap.docs[0].id, ...(snap.docs[0].data() as Omit<Product, "id">) };
  if (!isSellableProduct(product) || product.unitPriceCents <= 0) return null;

  let checkoutPageSlug: string | null = null;
  if (product.checkoutPageId) {
    const page = await db
      .doc(`subAccounts/${subAccountId}/checkoutPages/${product.checkoutPageId}`)
      .get();
    const p = page.data();
    if (page.exists && p?.status === "published" && p.productId === product.id) {
      checkoutPageSlug = typeof p.slug === "string" ? p.slug : null;
    }
  }

  return {
    sub,
    agencyId: sub.agencyId,
    product,
    brand: await loadBrand(subAccountId, sub),
    checkoutPageSlug,
  };
}

/** Brand for pages that must render even when the product is unavailable. */
export async function loadBuyBrand(subAccountId: string): Promise<BuyBrand> {
  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  return loadBrand(subAccountId, (snap.data() ?? {}) as Partial<SubAccountDoc>);
}

const PAGE_PATH = /^[a-zA-Z0-9][a-zA-Z0-9/_.-]{0,199}$/;

/** Length-capped, shape-checked; display and return links only. */
export function sanitizeWebsiteRef(raw: unknown): OrderWebsiteRef | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const siteId =
    typeof r.siteId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(r.siteId)
      ? r.siteId
      : null;
  const page =
    typeof r.page === "string" && PAGE_PATH.test(r.page) && !r.page.includes("..")
      ? r.page
      : null;
  return siteId || page ? { siteId, page } : null;
}

/**
 * A link back to the sub-account's own website (optionally a page on it).
 * Hosts only come from our website docs, so this can't become an open redirect.
 */
export async function websiteReturnUrl(
  subAccountId: string,
  ref: OrderWebsiteRef | null,
): Promise<{ url: string; host: string } | null> {
  try {
    const snap = await getAdminDb()
      .collection(`subAccounts/${subAccountId}/website`)
      .get();
    const sites = snap.docs.map((d) => d.data() as WebsiteDoc);
    const site =
      (ref?.siteId && sites.find((s) => s.gitpagePageId === ref.siteId)) ||
      sites.find((s) => !!siteAddress(s));
    const address = site ? siteAddress(site) : null;
    if (!address) return null;
    const base = new URL(address);
    const url = ref?.page && ref.siteId ? new URL(ref.page, base) : base;
    if (url.host !== base.host || url.protocol !== "https:") return null;
    return { url: url.toString(), host: base.host };
  } catch {
    return null;
  }
}

export function deliverySnapshots(products: Product[]): OrderDeliverySnapshot[] {
  const out: OrderDeliverySnapshot[] = [];
  for (const p of products) {
    const d = p.delivery;
    if (d && d.type !== "none") out.push({ productId: p.id, delivery: d });
  }
  return out;
}
