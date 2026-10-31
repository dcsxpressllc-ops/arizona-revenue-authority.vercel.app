/**
 * The four home-screen icon variants, shared by the canvas renderer, upload
 * validation, serving route and manifest. `pad` is the margin fraction per
 * side: maskable keeps the mark in the middle ~70% because Android crops to a
 * circle/squircle; Apple ignores transparency so its variant gets a filled
 * background. No "server-only" (the client renderer imports it).
 */

export const ICON_VARIANTS = [
  { key: "192", size: 192, pad: 0.08 },
  { key: "512", size: 512, pad: 0.08 },
  { key: "maskable", size: 512, pad: 0.15 },
  { key: "apple", size: 180, pad: 0.12 },
] as const;

export type IconVariantKey = (typeof ICON_VARIANTS)[number]["key"];

/** Matches the manifest theme. */
export const ICON_BACKGROUND = "#18181b";

/** Decoded PNG cap. Icons are stored as base64 in Firestore, one doc each, so this keeps docs well under 1MB after base64 overhead. */
export const ICON_MAX_BYTES = 500_000;

import { LANDING_VARIANT } from "@/config/landing";

/** Fallbacks until an owner uploads: "custom" deployments get the green "my CRM" set, the LeadStack demo the chevron set (scripts/render-pwa-icons.mjs). */
const CUSTOM_FALLBACKS: Record<IconVariantKey, string> = {
  "192": "/icon-192.png",
  "512": "/icon-512.png",
  maskable: "/icon-maskable-512.png",
  apple: "/apple-touch-icon.png",
};

const LEADSTACK_FALLBACKS: Record<IconVariantKey, string> = {
  "192": "/leadstack-icon-192.png",
  "512": "/leadstack-icon-512.png",
  maskable: "/leadstack-icon-maskable-512.png",
  apple: "/leadstack-apple-touch-icon.png",
};

export const ICON_STATIC_FALLBACKS: Record<IconVariantKey, string> =
  LANDING_VARIANT === "custom" ? CUSTOM_FALLBACKS : LEADSTACK_FALLBACKS;
