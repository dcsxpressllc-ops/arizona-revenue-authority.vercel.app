import type { MetadataRoute } from "next";
import { LANDING_VARIANT } from "@/config/landing";
import { COMPARISON_SLUGS } from "@/data/comparisons";
import { SITE_URL } from "@/components/landing/landing-meta";

/**
 * Variant-aware: the LeadStack site lists its docs and comparison pages;
 * "custom" clones list only their own pages (the vs pages 404 there).
 */
/**
 * Real last-modified dates (YYYY-MM-DD). Google learns to ignore a "now" on
 * every build, so bump an entry only when that page's content changes.
 */
const LAST_MODIFIED: Record<string, string> = {
  "/": "2026-09-07",
  "/terms": "2026-09-04",
  "/privacy": "2026-09-04",
  "/docs/api": "2026-06-01",
  "/docs/architecture": "2026-06-01",
  "/docs/updating": "2026-07-23",
  "/affiliate-program": "2026-09-03",
  "/gohighlevel-alternatives": "2026-09-07",
  "/go-high-level-pricing": "2026-09-18",
  "/leadstack-vs-gohighlevel": "2026-09-07",
  "/leadstack-vs-hubspot": "2026-09-04",
  "/leadstack-vs-activecampaign": "2026-09-04",
  "/leadstack-vs-vendasta": "2026-09-04",
};

export default function sitemap(): MetadataRoute.Sitemap {
  // See SITE_URL in landing-meta.ts.
  const baseUrl = SITE_URL;
  const buildTime = new Date();
  const modified = (path: string): Date =>
    LAST_MODIFIED[path] ? new Date(`${LAST_MODIFIED[path]}T00:00:00Z`) : buildTime;

  const sharedEntries: MetadataRoute.Sitemap = [
    { url: `${baseUrl}/`, lastModified: modified("/"), changeFrequency: "weekly", priority: 1.0 },
    { url: `${baseUrl}/terms`, lastModified: modified("/terms"), changeFrequency: "yearly", priority: 0.3 },
    { url: `${baseUrl}/privacy`, lastModified: modified("/privacy"), changeFrequency: "yearly", priority: 0.3 },
  ];

  if (LANDING_VARIANT !== "leadstack") {
    return sharedEntries;
  }

  const leadstackOnly: MetadataRoute.Sitemap = [
    { url: `${baseUrl}/docs/api`, lastModified: modified("/docs/api"), changeFrequency: "monthly", priority: 0.6 },
    { url: `${baseUrl}/docs/architecture`, lastModified: modified("/docs/architecture"), changeFrequency: "monthly", priority: 0.6 },
    { url: `${baseUrl}/docs/updating`, lastModified: modified("/docs/updating"), changeFrequency: "monthly", priority: 0.4 },
    { url: `${baseUrl}/affiliate-program`, lastModified: modified("/affiliate-program"), changeFrequency: "monthly", priority: 0.5 },
    { url: `${baseUrl}/gohighlevel-alternatives`, lastModified: modified("/gohighlevel-alternatives"), changeFrequency: "monthly", priority: 0.8 },
    // Vendors change list prices without notice, so this one is re-checked more often.
    { url: `${baseUrl}/go-high-level-pricing`, lastModified: modified("/go-high-level-pricing"), changeFrequency: "weekly", priority: 0.9 },
    ...COMPARISON_SLUGS.map((slug) => ({
      url: `${baseUrl}/leadstack-vs-${slug}`,
      lastModified: modified(`/leadstack-vs-${slug}`),
      changeFrequency: "monthly" as const,
      priority: 0.8,
    })),
  ];

  return [...sharedEntries, ...leadstackOnly];
}
