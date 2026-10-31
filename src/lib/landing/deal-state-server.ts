import "server-only";

import { unstable_cache } from "next/cache";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  coerceCohortState,
  emptyCohortState,
  type FoundersCohortState,
} from "@/lib/landing/cohort-state";
import {
  DEAL_STATE_TAG,
  DEAL_STATE_REVALIDATE_SECONDS,
} from "@/lib/landing/deal-cache";

/**
 * Cached server read of `appConfig/foundersCohort` (tag-busted on Deal editor
 * save), so it costs the landing ~0 reads. Needed alongside the client
 * subscription because that takes 1-3s, and until then the defaults say the
 * deal is live: a retail page would flash "$891" then jump to "$1,782". With
 * the seed the first HTML has the right price.
 *
 * null on failure; the client hook then just keeps its defaults.
 */
async function readDealState(): Promise<FoundersCohortState | null> {
  try {
    const snap = await getAdminDb().doc("appConfig/foundersCohort").get();
    if (!snap.exists) return emptyCohortState();
    return coerceCohortState(snap.data() as Record<string, unknown>);
  } catch (err) {
    console.error("[deal-state-server] read failed", err);
    return null;
  }
}

export const getDealStateCached = unstable_cache(
  readDealState,
  ["deal-state"],
  {
    tags: [DEAL_STATE_TAG],
    revalidate: DEAL_STATE_REVALIDATE_SECONDS,
  },
);
