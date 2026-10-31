/**
 * Allowed values for gitpage's POST /api/v1/generate-site (buildType "local").
 * gitpage silently falls back to defaults on unknown values, which looks like
 * the form did nothing, so dropdowns use these lists and validation rejects
 * anything else. Source: gitpage integration spec section 4.5.
 */

export const GITPAGE_LANGUAGES = [
  "English",
  "Spanish (Español)",
  "French (Français)",
  "German (Deutsch)",
  "Italian (Italiano)",
  "Portuguese (Português)",
  "Dutch (Nederlands)",
  "Polish (Polski)",
  "Czech (Čeština)",
  "Romanian (Română)",
  "Swedish (Svenska)",
  "Indonesian (Bahasa Indonesia)",
] as const;

export const GITPAGE_COLOR_SCHEMES = ["Standard", "Dark Mode"] as const;

export const GITPAGE_DESIGN_COLOR_PALETTES = [
  "Modern / Startup",
  "Minimal / Clean",
  "Bold / Creative",
  "Custom",
] as const;

export const GITPAGE_DESIGN_TYPOGRAPHY = [
  "Professional / Corporate",
  "Friendly / Soft",
  "Tech / Futuristic",
] as const;

export const GITPAGE_DESIGN_LAYOUT = [
  "Spacious",
  "Compact",
  "Modular",
] as const;

export const GITPAGE_DESIGN_COMPONENTS = [
  "Rounded & Soft",
  "Neutral & Sharp",
  "Bold & Loud",
] as const;

export const GITPAGE_DESIGN_INTERACTIONS = ["Energetic", "Subtle"] as const;

// The spec doesn't enumerate button or contact-form values, so these are a
// starter list on a free-text field. Unknown values aren't rejected; gitpage
// just uses its defaults.
export const GITPAGE_DESIGN_BUTTONS = [
  "Solid Primary",
  "Outline",
  "Ghost",
  "Pill",
] as const;

export const GITPAGE_DESIGN_CONTACT_FORM = [
  "Centered Card",
  "Inline",
  "Sidebar",
] as const;

export const GITPAGE_DESIGN_ICONS = [
  "Heroicons Outline",
  "Font Awesome Solid",
  "Material Icons Rounded",
  "Lucide Icons",
] as const;
