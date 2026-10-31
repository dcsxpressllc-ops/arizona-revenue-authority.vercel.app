import "server-only";

import { revalidateTag } from "next/cache";
import { BUYER_MAP_DATA_TAG } from "@/lib/landing/buyer-map-cache";

/**
 * Busts the cached map aggregate after a purchase with geo (Stripe founders
 * webhook, manual-purchase route). Best-effort; the safety-net revalidate
 * covers a miss.
 */
export function revalidateBuyerMap(): void {
  try {
    revalidateTag(BUYER_MAP_DATA_TAG);
  } catch (err) {
    console.error("[buyer-map] revalidate failed", err);
  }
}
