/**
 * Data Cache tags for the landing world map, in one module so the cached
 * readers and every invalidation site (config PATCH, purchase webhook, manual
 * purchase route) use the same strings. Nothing is read per view; both config
 * and aggregate refresh on change, with a long time-based safety net.
 */

/** Busted on each new purchase. */
export const BUYER_MAP_DATA_TAG = "buyer-map";

/** Busted on each editor save. */
export const BUYER_MAP_CONFIG_TAG = "buyer-map-config";

/** Seconds, in case an invalidation is missed. */
export const BUYER_MAP_REVALIDATE_SECONDS = 3600;
