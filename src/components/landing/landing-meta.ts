// Hello world
export const LANDING_LAST_UPDATED = "2026-01-01";
export const SITE_URL =
  process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ??
  "http://localhost:3000";
export const LEADSTACK_DESCRIPTOR = "";
export const LEADSTACK_TAGLINE = "";
export const SOCIAL_PROFILES: readonly string[] = [];
export const RETAIL_PRICE_USD = 0;
export const DEAL_PRICE_USD = 0;
export function formatLandingUpdated(_iso?: string): string {
  return "";
}
