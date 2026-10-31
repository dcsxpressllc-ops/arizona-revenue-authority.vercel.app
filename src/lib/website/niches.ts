import type {
  ColorScheme,
  Niche,
  WebsiteConfig,
} from "@/types/website";
import {
  sampleAiAutomationLocalConfig,
  sampleAiAutomationVslConfig,
  sampleAiConsultingLocalConfig,
  sampleAiConsultingVslConfig,
  sampleAgencyConsultingLocalConfig,
  sampleAgencyConsultingVslConfig,
  sampleGymFitnessLocalConfig,
  sampleGymFitnessVslConfig,
  sampleHomeServicesLocalConfig,
  sampleHomeServicesVslConfig,
  sampleRealEstateLocalConfig,
  sampleRealEstateVslConfig,
} from "@/types/website";

/**
 * Niche metadata used by lib/gitpage/client.ts, lib/website/validation.ts and
 * the website picker. Labels/descriptions are operator-facing. Default
 * colorScheme is gitpage's recommended surface; the operator can override.
 * Every niche gets the same forced pages (index, services, contact, privacy,
 * terms); no blog.
 */

export const NICHE_KEYS: readonly Niche[] = [
  "home_services",
  "real_estate",
  "gym_fitness",
  "agency_consulting",
  "ai_consulting",
  "ai_automation",
] as const;

export interface NicheMeta {
  key: Niche;
  label: string;
  shortLabel: string;
  description: string;
  defaultColorScheme: ColorScheme;
  /** Tile glyph. */
  emoji: string;
  /** Remote-first: contact page works without a street address. */
  addressOptional?: boolean;
}

export const NICHE_META: Record<Niche, NicheMeta> = {
  home_services: {
    key: "home_services",
    label: "Home Services",
    shortLabel: "Home Services",
    description: "Plumbers / HVAC / Electricians / Roofers",
    defaultColorScheme: "Standard",
    emoji: "🔧",
  },
  real_estate: {
    key: "real_estate",
    label: "Real Estate",
    shortLabel: "Real Estate",
    description: "Buyers / Sellers / Investors",
    defaultColorScheme: "Standard",
    emoji: "🏠",
  },
  gym_fitness: {
    key: "gym_fitness",
    label: "Gyms & Fitness",
    shortLabel: "Gym & Fitness",
    description: "Studios / PTs / Boutique Gyms",
    defaultColorScheme: "Dark Mode",
    emoji: "💪",
  },
  agency_consulting: {
    key: "agency_consulting",
    label: "Agency & Consulting",
    shortLabel: "Agency",
    description: "Studios / Consultancies / B2B services",
    defaultColorScheme: "Standard",
    emoji: "🎯",
  },
  ai_consulting: {
    key: "ai_consulting",
    label: "AI Consulting",
    shortLabel: "AI Consulting",
    description: "Strategy / Readiness / Governance / Training",
    defaultColorScheme: "Standard",
    emoji: "🧭",
    addressOptional: true,
  },
  ai_automation: {
    key: "ai_automation",
    label: "AI Automation Agency",
    shortLabel: "AI Automation",
    description: "AI agents / Workflow automation / Chat & voice bots",
    defaultColorScheme: "Dark Mode",
    emoji: "⚡",
    addressOptional: true,
  },
};

/** Forced on by gitpage for niche builds. Sent as-is; mirrored to
 *  local_page_selections for the UI. */
export const NICHE_FORCED_PAGES = [
  "index.html",
  "services.html",
  "contact.html",
  "privacy.html",
  "terms.html",
] as const;

/** gitpage rejects these on niche builds. */
export const NICHE_FORBIDDEN_PAGES = ["blog.html", "blog-listing.html"] as const;

export function isNicheKey(value: unknown): value is Niche {
  return (
    typeof value === "string" &&
    (NICHE_KEYS as readonly string[]).includes(value)
  );
}

/** Sample-config builder for the Sample button. */
export function nicheSample(
  niche: Niche,
  buildType: "local" | "vsl",
): () => WebsiteConfig {
  switch (niche) {
    case "home_services":
      return buildType === "vsl"
        ? sampleHomeServicesVslConfig
        : sampleHomeServicesLocalConfig;
    case "real_estate":
      return buildType === "vsl"
        ? sampleRealEstateVslConfig
        : sampleRealEstateLocalConfig;
    case "gym_fitness":
      return buildType === "vsl"
        ? sampleGymFitnessVslConfig
        : sampleGymFitnessLocalConfig;
    case "agency_consulting":
      return buildType === "vsl"
        ? sampleAgencyConsultingVslConfig
        : sampleAgencyConsultingLocalConfig;
    case "ai_consulting":
      return buildType === "vsl" ? sampleAiConsultingVslConfig : sampleAiConsultingLocalConfig;
    case "ai_automation":
      return buildType === "vsl" ? sampleAiAutomationVslConfig : sampleAiAutomationLocalConfig;
  }
}
