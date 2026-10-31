/**
 * Curated business-type picklist for Get Leads. Client-safe: the page renders
 * it and the search route validates against it, so a forged request can't run
 * arbitrary Outscraper queries on the agency's key. `query` is plural and
 * colloquial because that ranks best in Maps.
 */

/**
 * Parked switch. While true, the sidebar entry, Manage-dialog toggle,
 * assistant capability and KB card are hidden; routes and the
 * getLeadsEnabledByAgency gate remain but are unreachable. To un-park, set
 * false and restore the Outscraper group in src/lib/setup/env-schema.mjs and
 * OUTSCRAPER_API_KEY in .env.example (they can't read this flag). Typed
 * `boolean` so TS doesn't narrow dead branches into unused-import errors.
 */
export const GET_LEADS_PARKED: boolean = true;
export interface BusinessType {
  value: string;
  label: string;
  query: string;
}

export const BUSINESS_TYPES: BusinessType[] = [
  { value: "restaurant", label: "Restaurants", query: "restaurants" },
  { value: "cafe", label: "Cafes & coffee shops", query: "cafes" },
  { value: "dentist", label: "Dentists", query: "dentists" },
  { value: "law-firm", label: "Law firms", query: "law firms" },
  { value: "accounting", label: "Accounting firms", query: "accounting firms" },
  { value: "real-estate", label: "Real estate agencies", query: "real estate agencies" },
  { value: "plumber", label: "Plumbers", query: "plumbers" },
  { value: "electrician", label: "Electricians", query: "electricians" },
  { value: "roofing", label: "Roofing contractors", query: "roofing contractors" },
  { value: "hvac", label: "HVAC services", query: "HVAC services" },
  { value: "landscaping", label: "Landscaping & lawn care", query: "landscaping services" },
  { value: "cleaning", label: "Cleaning services", query: "cleaning services" },
  { value: "auto-repair", label: "Auto repair shops", query: "auto repair shops" },
  { value: "gym", label: "Gyms & fitness studios", query: "gyms" },
  { value: "salon", label: "Hair & beauty salons", query: "hair salons" },
  { value: "chiropractor", label: "Chiropractors", query: "chiropractors" },
  { value: "vet", label: "Veterinary clinics", query: "veterinary clinics" },
  { value: "physio", label: "Physiotherapy clinics", query: "physiotherapy clinics" },
  { value: "photographer", label: "Photographers", query: "photographers" },
  { value: "builder", label: "Builders & renovations", query: "building contractors" },
];

export function businessTypeByValue(value: string): BusinessType | undefined {
  return BUSINESS_TYPES.find((t) => t.value === value);
}

/**
 * Operator-added types, stored as labels on `getLeadsCustomTypes` (PUT
 * /api/sub-accounts/[id]/get-leads/types, admin only). The label is the Maps
 * query; values get a "custom:" prefix so they can't collide with or spoof a
 * curated entry.
 */
export const GET_LEADS_MAX_CUSTOM_TYPES = 30;
export const GET_LEADS_CUSTOM_TYPE_MAX_LEN = 60;

export function slugifyBusinessType(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, GET_LEADS_CUSTOM_TYPE_MAX_LEN);
}

export function customBusinessTypes(labels: string[]): BusinessType[] {
  return labels
    .filter((l) => typeof l === "string" && l.trim())
    .map((l) => ({
      value: `custom:${slugifyBusinessType(l)}`,
      label: l.trim(),
      query: l.trim(),
    }));
}

/** Curated list plus saved custom labels form the server-side allowlist. Custom entries had to be saved by an admin first. */
export function resolveBusinessType(
  value: string,
  customLabels: string[],
): BusinessType | undefined {
  return (
    businessTypeByValue(value) ??
    customBusinessTypes(customLabels).find((t) => t.value === value)
  );
}

/** km. Validated server-side too. */
export const RADIUS_OPTIONS_KM = [1, 5, 10, 25, 50] as const;
export type RadiusKm = (typeof RADIUS_OPTIONS_KM)[number];

/** Outscraper's `limit` caps both results and enrichment spend, so this is the per-run credit budget. Validated server-side. */
export const RESULT_LIMIT_OPTIONS = [10, 20, 40] as const;

/** Largest picker option; also the import batch cap. */
export const GET_LEADS_RESULT_LIMIT = 40;
