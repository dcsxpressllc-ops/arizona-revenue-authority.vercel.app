import "server-only";

import { unstable_cache } from "next/cache";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  coerceBuyerMapConfig,
  BUYER_MAP_DEFAULTS,
  type BuyerMapConfig,
} from "@/lib/buyer-map-config";
import {
  BUYER_MAP_CONFIG_TAG,
  BUYER_MAP_REVALIDATE_SECONDS,
} from "@/lib/landing/buyer-map-cache";

/**
 * Cached read of `appConfig/buyerWorldMap` (busted by the config PATCH route,
 * long safety-net revalidate). Read here rather than via the client hook so
 * `enabled` is known at render and the section never flashes.
 */
async function readConfig(): Promise<BuyerMapConfig> {
  try {
    const snap = await getAdminDb().doc("appConfig/buyerWorldMap").get();
    return coerceBuyerMapConfig(
      snap.data() as Partial<BuyerMapConfig> | undefined,
    );
  } catch (err) {
    console.error("[buyer-map-config-server] read failed", err);
    return { ...BUYER_MAP_DEFAULTS };
  }
}

export const getBuyerMapConfigCached = unstable_cache(
  readConfig,
  ["buyer-map-config"],
  { tags: [BUYER_MAP_CONFIG_TAG], revalidate: BUYER_MAP_REVALIDATE_SECONDS },
);
