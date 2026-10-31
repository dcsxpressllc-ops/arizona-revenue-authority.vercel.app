import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { CUSTOM_BRAND, type ResolvedBrand } from "@/config/landing";
import type { AgencyDoc } from "@/types";

/**
 * Brand for the custom landing: appConfig/main -> firstAgencyId ->
 * agencies/{id}, merged over CUSTOM_BRAND so unset fields still render on a
 * fresh deploy. Errors are swallowed (the public landing must never 500);
 * worst case everything is CUSTOM_BRAND. One read per render; add ISR or
 * memoize if traffic grows.
 */
export async function resolveCustomBrand(): Promise<ResolvedBrand> {
  const fallback: ResolvedBrand = {
    name: CUSTOM_BRAND.name,
    logoUrl: null,
    tagline: CUSTOM_BRAND.tagline,
    shortDescription: CUSTOM_BRAND.shortDescription,
    supportEmail: CUSTOM_BRAND.supportEmail,
    primaryDomain: CUSTOM_BRAND.primaryDomain,
  };

  try {
    const db = getAdminDb();
    const configSnap = await db.doc("appConfig/main").get();
    const firstAgencyId = configSnap.exists
      ? (configSnap.data()?.firstAgencyId as string | undefined)
      : undefined;
    if (!firstAgencyId) return fallback;

    const agencySnap = await db.doc(`agencies/${firstAgencyId}`).get();
    if (!agencySnap.exists) return fallback;
    const agency = agencySnap.data() as Partial<AgencyDoc>;

    return {
      name:
        agency.name && agency.name !== "LeadStack"
          ? agency.name
          : fallback.name,
      logoUrl: (agency.logoUrl as string | null) ?? null,
      tagline: fallback.tagline,
      shortDescription: fallback.shortDescription,
      supportEmail: agency.supportEmail || fallback.supportEmail,
      primaryDomain: agency.primaryDomain || fallback.primaryDomain,
    };
  } catch {
    return fallback;
  }
}

/** Brand name for transactional copy: agency Branding name, then CUSTOM_BRAND.name, then "LeadStack". Never throws. */
export async function resolveBrandName(): Promise<string> {
  try {
    const { name } = await resolveCustomBrand();
    return name || "LeadStack";
  } catch {
    return "LeadStack";
  }
}
