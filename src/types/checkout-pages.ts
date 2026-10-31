import type { Timestamp, FieldValue } from "firebase/firestore";
import type { FormField, FormAppearance } from "@/types/forms";
import type { PipelineStageId } from "@/types/deals";

/**
 * Public offer page at `/co/[subAccountId]/[slug]`: main product, up to 3
 * order bumps, and the fields collected before handing off to Stripe. We own
 * this page because Stripe Checkout can't do "tick to add X".
 *
 * Stored as config under `subAccounts/{id}/checkoutPages/{pageId}` (like
 * bookingPages). Reuses the form field/appearance model so capture, `mapsTo`
 * and theming match `/f/[formId]`.
 */

export const MAX_BUMPS_PER_CHECKOUT_PAGE = 3;

/**
 * Ids are persisted, so this list is append-only; never rename one. Unknown
 * ids fall back to the appearance-based look. Tokens live in
 * lib/checkout/themes.ts.
 */
export const CHECKOUT_THEME_IDS = [
  "clean",
  "midnight",
  "noir-lime",
  "sunset",
  "ocean",
] as const;
export type CheckoutThemeId = (typeof CHECKOUT_THEME_IDS)[number];

export interface CheckoutPage {
  id: string;

  agencyId: string;
  subAccountId: string;
  createdByUid: string;

  /** Unique per sub-account, lowercase kebab. */
  slug: string;
  /** Internal only. */
  name: string;
  /** Drafts 404 publicly. */
  status: "draft" | "published";

  /** Snapshotted into the order at checkout. */
  productId: string;
  /**
   * Each must be an active, bumpEligible product in the same currency as the
   * main offer (one Stripe session can't mix currencies).
   */
  bumpProductIds: string[];

  headline: string;
  subheadline: string;

  collectFields: FormField[];
  /** Applied to the contact created/matched at checkout. */
  autoTags: string[];
  pipelineStageId: PipelineStageId | null;

  /** Null = our own thanks page. */
  successUrl: string | null;

  /**
   * Null/absent on older docs, which use the `appearance`-derived look;
   * "clean" and "midnight" reproduce it exactly.
   */
  themePreset?: CheckoutThemeId | null;

  appearance: FormAppearance;

  createdAt: Timestamp | FieldValue | null;
  updatedAt: Timestamp | FieldValue | null;
}

/** Used on both client (preview) and server so the saved slug matches what the operator saw. */
export function slugifyCheckoutSlug(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** So a page can't shadow a sibling route under /co ("buy" is the express buy link). */
const RESERVED_SLUGS = new Set(["api", "new", "thanks", "preview", "buy"]);

export function isReservedCheckoutSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug);
}

export function checkoutSlugError(slug: string): string | null {
  if (!slug) return "Add a URL slug.";
  if (slug.length < 2) return "Slug must be at least 2 characters.";
  if (RESERVED_SLUGS.has(slug)) return `"${slug}" is reserved — pick another.`;
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug)) {
    return "Use lowercase letters, numbers and hyphens (can't start or end with a hyphen).";
  }
  return null;
}
