import { hasCardRail } from "@/lib/payments/can-take-payment";
import type { Product, ProductDelivery } from "@/types/products";
import type { SubAccountDoc } from "@/types/tenancy";

/**
 * Client-safe Sell Online helpers, shared by the Products UI and the server
 * routes so what the operator sees matches what the API enforces.
 */

export type ProductKind = "service" | "course" | "download";

type SellOnlineSub = Pick<
  SubAccountDoc,
  "sellOnlineEnabledByAgency" | "paymentsEnabledByAgency" | "stripeConnectionMeta"
>;

export function sellOnlineGateOn(
  sub: Partial<SellOnlineSub> | null | undefined,
): boolean {
  return sub?.sellOnlineEnabledByAgency === true;
}

/** Gate on plus a card rail that can confirm payments. */
export function sellOnlineReady(
  sub: Partial<SellOnlineSub> | null | undefined,
): boolean {
  return sellOnlineGateOn(sub) && hasCardRail(sub);
}

export function isSellableProduct(
  p: Pick<Product, "active" | "sellOnline" | "slug">,
): boolean {
  return p.active === true && p.sellOnline === true && !!p.slug;
}

export function productKind(delivery: ProductDelivery | undefined): ProductKind {
  if (delivery?.type === "community") return "course";
  if (delivery?.type === "download") return "download";
  return "service";
}

export function slugifyProductSlug(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

export function productSlugError(slug: string): string | null {
  if (!slug) return "Add a URL slug.";
  if (slug.length < 2) return "Slug must be at least 2 characters.";
  if (slug.length > 60) return "Keep the slug under 60 characters.";
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug)) {
    return "Use lowercase letters, numbers and hyphens (can't start or end with a hyphen).";
  }
  // Sibling route under /co/[saId]/buy/.
  if (slug === "thanks") return `"${slug}" is reserved, pick another.`;
  return null;
}

/** Path of the express buy link; prefix with the app origin for a full URL. */
export function expressBuyPath(subAccountId: string, slug: string): string {
  return `/co/${subAccountId}/buy/${slug}`;
}

export function isHttpsUrl(raw: string): boolean {
  try {
    return new URL(raw).protocol === "https:";
  } catch {
    return false;
  }
}

export const PUBLIC_DESCRIPTION_MAX = 2_000;
export const IMAGE_ALT_MAX = 200;
export const DOWNLOAD_LABEL_MAX = 80;
