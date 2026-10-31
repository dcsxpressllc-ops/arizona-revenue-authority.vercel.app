/**
 * Data Cache tag for the server-rendered deal state, shared by
 * deal-state-server.ts and the Deal editor's PATCH route (same model as
 * buyer-map-cache.ts). The client subscription corrects a stale cache within
 * a second anyway; the bust makes a save show on first paint. `soldCount` is
 * edited in the console with no write path to hook, hence the short revalidate.
 */

export const DEAL_STATE_TAG = "deal-state";

/** Seconds; covers edits made outside the Deal editor. */
export const DEAL_STATE_REVALIDATE_SECONDS = 300;
