import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import type { AgencyDoc } from "@/types";

/**
 * Agency messaging policy: may sub-accounts use the shared env-var Twilio
 * sender, or must they bring their own number? Read on every SMS send and in
 * workflow readiness, so cached briefly per agency.
 */

const TTL_MS = 60 * 1000;
const cache = new Map<string, { at: number; allowed: boolean }>();

/** Shared SMS fallback allowed? Unset reads as true, and a missing agencyId returns true so platform sends never break. */
export async function agencyAllowsSharedSms(
  agencyId: string | null | undefined,
): Promise<boolean> {
  if (!agencyId) return true;

  const hit = cache.get(agencyId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.allowed;

  let allowed = true;
  try {
    const snap = await getAdminDb().doc(`agencies/${agencyId}`).get();
    const data = snap.data() as Pick<AgencyDoc, "sharedSmsAllowed"> | undefined;
    // Only an explicit `false` disables the shared fallback.
    allowed = data?.sharedSmsAllowed !== false;
  } catch {
    // Fail open on read errors so legitimate sends aren't silently blocked.
    allowed = true;
  }

  cache.set(agencyId, { at: Date.now(), allowed });
  return allowed;
}

/** Drop the cached policy after the owner toggles it. */
export function invalidateAgencyPolicyCache(agencyId: string): void {
  cache.delete(agencyId);
}
