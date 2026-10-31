import type { Timestamp, FieldValue } from "firebase/firestore";
import type { FormAppearance } from "@/types/forms";

/**
 * Funnels (Labs, may be withdrawn). Content + sequencing around the existing
 * checkout: the offer step references a `checkoutPages` doc, so there is one
 * money path in the codebase. Don't add a second one here.
 *
 * Steps: landing -> offer (checkout page at /co/[saId]/[slug], or a plain URL
 * for lead-gen) -> thanks. Stored at `subAccounts/{id}/funnels/{funnelId}`,
 * public at `/fn/[subAccountId]/[slug]`.
 */

export type FunnelTemplateKey = "simple_offer" | "vsl" | "lead_magnet";

export interface FunnelLanding {
  headline: string;
  subheadline: string;
  /** Checklist lines, max 6. */
  bullets: string[];
  /** Already normalised + host-checked embed URL. */
  videoUrl: string | null;
  /** https only. */
  imageUrl: string | null;
  ctaLabel: string;
}

/** See lib/funnels/sections.ts. */
export type FunnelSectionType =
  | "hero"
  | "video"
  | "benefits"
  | "features"
  | "testimonials"
  | "faq"
  | "offer"
  | "guarantee"
  | "bio"
  | "logos"
  | "urgency"
  | "text"
  | "image"
  | "cta"
  /** Numbered how-it-works. */
  | "steps"
  /** Big-number band. Real figures only. */
  | "stats"
  /** With-us vs without-us, two columns. */
  | "comparison"
  | "pullquote"
  /** Long-form first-person narrative. */
  | "story"
  /** Priced tiers with compare-at and scarcity. */
  | "pricing";

/** Generic repeater row: bullet, feature, testimonial, FAQ pair or logo. */
export interface FunnelSectionItem {
  /** Bullet text / feature name / question / quote. */
  title: string;
  /** Description / answer / attribution. */
  body: string;
  /** Free slot: role+company on a testimonial, image URL on a logo. */
  meta: string;
  /** https only. */
  imageUrl?: string | null;
  /** 1-5 stars on a testimonial. Null hides the row. */
  rating?: number | null;
  /** Called-out outcome ("+$50K/mo in 60 days"). Only a real, supplied result, never model-invented. */
  result?: string;
}

/** One shape for every section type; SECTION_META decides which fields the editor shows. */
export interface FunnelSection {
  id: string;
  type: FunnelSectionType;
  heading: string;
  subheading: string;
  /** Newlines preserved on render. */
  body: string;
  items: FunnelSectionItem[];
  /** Normalised video embed URL, or an https image URL. */
  mediaUrl: string | null;
  ctaLabel: string;
  /** ISO datetime, urgency sections. */
  deadline: string | null;
  /** Absent on older docs = "default". */
  background?: FunnelSectionBackground;
  /** Story sections default on. */
  alignLeft?: boolean;
  /** Struck-through anchor price, e.g. "Normally $1,997". */
  compareAt?: string;
  /** 0-100 sold-out bar. Only use a real number. */
  scarcityPercent?: number | null;
  /** Story byline, e.g. "From: Jane Doe". */
  attribution?: string;
  /** Eyebrow pill above a hero/CTA heading. Keep it short and true. */
  badge?: string;
  /** Hero only: full-bleed background image under a dark overlay. */
  mediaAsBackground?: boolean;
  /** What the image should show, set by the AI drafter; kept after mediaUrl is filled so it can be re-searched. */
  imageQuery?: string;
}

/**
 * Full-bleed band behind a section (content stays in the max-width column).
 * Alternated automatically on add, overridable per section.
 */
export type FunnelSectionBackground =
  | "default"
  | "muted"
  | "dark"
  | "accent"
  | "accentSoft";

export const MAX_FUNNEL_SECTIONS = 30;
export const MAX_SECTION_ITEMS = 12;

export interface FunnelStyle {
  fontPair: FunnelFontPair;
  /** Multiplier on every heading size. 1 = base, 1.25 = big, 0.85 = compact. */
  headingScale: number;
  uppercaseHeadings: boolean;
  /** Content column width in px. */
  contentWidth: number;
}

export type FunnelFontPair =
  | "system"
  | "condensed"
  | "editorial"
  | "geometric"
  | "classic";

export function defaultFunnelStyle(): FunnelStyle {
  return {
    // Condensed reads like a sales page; system-ui reads like a form.
    fontPair: "condensed",
    headingScale: 1.15,
    uppercaseHeadings: false,
    contentWidth: 780,
  };
}

export interface FunnelThanks {
  headline: string;
  body: string;
  /** Redirect after a short delay. https only. */
  redirectUrl: string | null;
}

export interface Funnel {
  id: string;

  agencyId: string;
  subAccountId: string;
  createdByUid: string;

  slug: string;
  name: string;
  status: "draft" | "published";
  template: FunnelTemplateKey;

  /**
   * Legacy flat shape. When `sections` is empty the renderer synthesises
   * sections from it (sectionsFromLegacyLanding). New funnels leave it at defaults.
   */
  landing: FunnelLanding;

  /** Empty on older funnels. */
  sections: FunnelSection[];

  /**
   * Set when the operator picked a product instead of a checkout page. Saving
   * creates a real checkout page (stored in `checkoutPageId`); this is kept
   * only so the editor can show the choice.
   */
  productId: string | null;

  /**
   * Null for lead-gen funnels (then `ctaUrl` is used). Never inline a price;
   * the checkout page decides what is charged.
   */
  checkoutPageId: string | null;
  /** https only. */
  ctaUrl: string | null;

  /**
   * `{subdomain}.{app domain}` serves this funnel at its root. Globally unique;
   * the server-only `funnelSubdomains/{name}` claim is authoritative, this is a back-reference.
   */
  subdomain?: string | null;

  thanks: FunnelThanks;
  appearance: FormAppearance;
  /** Absent on older docs = defaultFunnelStyle(). */
  style?: FunnelStyle;
  stickyCta?: boolean;
  /** Second line inside every CTA button, e.g. "Starts Monday - 12 spots". */
  ctaSubtitle?: string;
  /**
   * Announcement bar above the hero, shown only when non-empty. No separate
   * toggle on purpose: an enabled-but-empty banner is an easy publishing accident.
   */
  topBanner?: string;

  createdAt: Timestamp | FieldValue | null;
  updatedAt: Timestamp | FieldValue | null;
}

export const MAX_FUNNEL_BULLETS = 6;

/** Same slug rules as checkout pages. */
export function slugifyFunnelSlug(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

const RESERVED = new Set(["api", "new", "thanks", "preview"]);

export function funnelSlugError(slug: string): string | null {
  if (!slug) return "Add a URL slug.";
  if (slug.length < 2) return "Slug must be at least 2 characters.";
  if (RESERVED.has(slug)) return `"${slug}" is reserved — pick another.`;
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug)) {
    return "Use lowercase letters, numbers and hyphens (can't start or end with a hyphen).";
  }
  return null;
}
