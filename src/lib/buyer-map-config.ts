/**
 * Editable copy + toggle for the landing page's Buyer World Map, stored at
 * `appConfig/buyerWorldMap` (Admin SDK writes only). The buyer geography itself
 * is a separate cached aggregate in lib/landing/buyer-map-data.ts; the headline
 * here is marketing copy and intentionally not tied to the live counts.
 *
 * No client-only imports: used by both the server component and the client hook.
 */
export interface BuyerMapConfig {
  /** When false the section never renders. */
  enabled: boolean;
  /** Small uppercase kicker above the heading. */
  eyebrow: string;
  /** e.g. "Bought by agencies across". */
  headingLead: string;
  /** Serif italic accent, e.g. "five continents." */
  headingEmphasis: string;
  /** Privacy floor: cities with fewer buyers aren't plotted, so no one buyer's town is pinpointed. 1 = show all. */
  minCityBuyers: number;
  /** "Total saved vs GoHighLevel" count-up. */
  showSavings: boolean;
  /** Assumed yearly GHL spend avoided per buyer. Total saved = buyers x this. */
  annualSavingsPerBuyer: number;
}

// Ships off: a fresh deployment shouldn't show a near-empty map until the
// operator turns it on from /agency/landing.
export const BUYER_MAP_DEFAULTS: BuyerMapConfig = {
  enabled: false,
  eyebrow: "Owned, not rented",
  headingLead: "Their own CRM, launched across",
  headingEmphasis: "five continents.",
  minCityBuyers: 1,
  showSavings: true,
  annualSavingsPerBuyer: 22000,
};

/** Untrusted Firestore payload to a complete, valid config. */
export function coerceBuyerMapConfig(
  data: Partial<BuyerMapConfig> | undefined | null,
): BuyerMapConfig {
  if (!data) return { ...BUYER_MAP_DEFAULTS };
  const strOr = (v: unknown, fallback: string, max: number) =>
    typeof v === "string" && v.trim() ? v.trim().slice(0, max) : fallback;
  return {
    enabled:
      typeof data.enabled === "boolean"
        ? data.enabled
        : BUYER_MAP_DEFAULTS.enabled,
    eyebrow: strOr(data.eyebrow, BUYER_MAP_DEFAULTS.eyebrow, 80),
    headingLead: strOr(data.headingLead, BUYER_MAP_DEFAULTS.headingLead, 120),
    headingEmphasis: strOr(
      data.headingEmphasis,
      BUYER_MAP_DEFAULTS.headingEmphasis,
      120,
    ),
    minCityBuyers:
      typeof data.minCityBuyers === "number" &&
      Number.isInteger(data.minCityBuyers) &&
      data.minCityBuyers >= 1
        ? Math.min(data.minCityBuyers, 100)
        : BUYER_MAP_DEFAULTS.minCityBuyers,
    showSavings:
      typeof data.showSavings === "boolean"
        ? data.showSavings
        : BUYER_MAP_DEFAULTS.showSavings,
    annualSavingsPerBuyer:
      typeof data.annualSavingsPerBuyer === "number" &&
      Number.isFinite(data.annualSavingsPerBuyer) &&
      data.annualSavingsPerBuyer >= 0
        ? Math.round(data.annualSavingsPerBuyer)
        : BUYER_MAP_DEFAULTS.annualSavingsPerBuyer,
  };
}
