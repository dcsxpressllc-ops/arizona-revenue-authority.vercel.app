/**
 * Landing-page config. Two landings ship:
 *
 *   - "custom" (default): a generic agency-CRM landing the buyer brands as
 *     their own; edit CUSTOM_BRAND first. Built for done-for-you sales, not
 *     self-serve: a "Talk to us" mailto CTA (CUSTOM_BRAND.supportEmail), the
 *     owner takes payment off-system, provisions a sub-account and invites the
 *     client. Pricing is hidden; see CUSTOM_BRAND.pricing to re-enable resale.
 *
 *   - "leadstack": the LeadStack marketing landing (leadstack.dev). Only use it
 *     for the public LeadStack demo.
 *
 * LANDING_VARIANT picks which one renders at "/".
 */

export type LandingVariant = "leadstack" | "custom";

export const LANDING_VARIANT: LandingVariant = "custom";

export interface CustomPricingTier {
  name: string;
  priceMonthly: number;
  priceAnnual: number;
  blurb: string;
  features: readonly string[];
  cta: string;
  highlighted: boolean;
}

export interface CustomBrand {
  name: string;
  tagline: string;
  shortDescription: string;
  supportEmail: string;
  primaryDomain: string;
  pricing: {
    starter: CustomPricingTier;
    pro: CustomPricingTier;
    scale: CustomPricingTier;
  };
}

/**
 * Brand passed to the custom landing at render time, resolved server-side by
 * lib/landing/resolve-brand.ts (agency doc first, CUSTOM_BRAND fills gaps).
 * `logoUrl` null means no logo: render the default gradient mark.
 */
export interface ResolvedBrand {
  name: string;
  logoUrl: string | null;
  tagline: string;
  shortDescription: string;
  supportEmail: string;
  primaryDomain: string;
}

/** Brand fields for the "custom" variant (ignored for "leadstack"). Placeholder defaults; edit to brand the landing. */
export const CUSTOM_BRAND: CustomBrand = {
  /** Navbar, hero, footer copyright, page title. */
  name: "YourCRM",

  /** Hero subtitle and meta description. */
  tagline: "The AI-powered CRM that works while you sleep",

  /** ~140 chars under the hero headline: what it does, for whom. */
  shortDescription:
    "Contacts, pipeline, and a website builder — plus AI agents that answer every lead by chat, text, and phone the moment it lands, 24/7. One branded workspace your team actually wants to use.",

  /** CTA buttons, FAQ "talk to us" line, footer. */
  supportEmail: "hello@yourbrand.com",

  /** Footer, og:url, canonical. No https://, no trailing slash. */
  primaryDomain: "yourbrand.com",

  /**
   * Pricing tiers. Hidden by default (done-for-you sales), so the Pricing
   * section and #pricing nav link don't render. Kept as a starting point for
   * Stripe-driven resale. To re-enable:
   *
   *   1. Render <CustomPricing /> in src/app/page.tsx (landing-custom/pricing.tsx).
   *   2. Re-add the "#pricing" link in landing-custom/navbar.tsx (desktop + mobile).
   *   3. Point the card buttons at createCheckoutSession with STRIPE_PRO_PRICE_ID
   *      etc. instead of /signup.
   *   4. Un-gate the Subscription panel in sub-account settings (gated on
   *      LANDING_VARIANT === "leadstack").
   *   5. Add a public signup that provisions agency + sub-account + owner on
   *      checkout.completed. /api/auth/signup is invite-only after the first
   *      user, so paying strangers have nowhere to land. See CLAUDE.md
   *      ("Auth & Tenancy Model").
   */
  pricing: {
    starter: {
      name: "Starter",
      priceMonthly: 0,
      priceAnnual: 0,
      blurb: "For solo operators kicking the tyres.",
      features: [
        "Up to 100 contacts",
        "1 sub-account",
        "Pipeline + tasks + calendar",
        "Forms with public hosted page",
        "Community support",
      ],
      cta: "Get started free",
      highlighted: false,
    },
    pro: {
      name: "Pro",
      priceMonthly: 97,
      priceAnnual: 77,
      blurb: "For growing teams with serious volume.",
      features: [
        "Unlimited contacts",
        "Unlimited sub-accounts",
        "Pipeline + Kanban + automations",
        "Email + SMS shared sender",
        "Built-in website builder",
        "Up to 5 team seats",
        "Priority email support",
      ],
      cta: "Start 14-day trial",
      highlighted: true,
    },
    scale: {
      name: "Scale",
      priceMonthly: 297,
      priceAnnual: 237,
      blurb: "For teams running multi-account workspaces.",
      features: [
        "Everything in Pro",
        "Unlimited team seats",
        "Advanced automations",
        "Audit logs + SSO",
        "Dedicated onboarding",
        "SLA-backed support",
      ],
      cta: "Talk to sales",
      highlighted: false,
    },
  },
};
