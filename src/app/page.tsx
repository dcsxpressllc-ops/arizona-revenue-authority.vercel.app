import { LANDING_VARIANT } from "@/config/landing";
import { resolveCustomBrand } from "@/lib/landing/resolve-brand";
import { resolveHeroVariant } from "@/lib/hero-variant-server";
import { getBuyerMapConfigCached } from "@/lib/landing/buyer-map-config-server";
import { getBuyerMapData, getBuyerSavings } from "@/lib/landing/buyer-map-data";
import { getDealStateCached } from "@/lib/landing/deal-state-server";
import { BuyerWorldMap } from "@/components/landing/buyer-world-map";
import { DealStateProvider } from "@/components/landing/deal-state-provider";
import { HomeSchema } from "@/components/landing/home-schema";

import { AnnouncementBar } from "@/components/landing/announcement-bar";
import { Navbar as LeadStackNavbar } from "@/components/landing/navbar";
import { Hero as LeadStackHero } from "@/components/landing/hero";
import { WhatIsLeadStack } from "@/components/landing/what-is-leadstack";
import { IntegrationsCarousel } from "@/components/landing/integrations-carousel";
import { HowItWorks } from "@/components/landing/how-it-works";
import { WorkspaceTour } from "@/components/landing/workspace-tour";
import { Features as LeadStackFeatures } from "@/components/landing/features";
import { MidPageCta } from "@/components/landing/mid-page-cta";
import { Comparison } from "@/components/landing/comparison";
// import { Support } from "@/components/landing/support"; // hidden for now
import { MakeItYours } from "@/components/landing/make-it-yours";
import { TestimonialsCarousel } from "@/components/landing/testimonials-carousel";
import { Pricing as LeadStackPricing } from "@/components/landing/pricing";
import { UneedReviews } from "@/components/landing/uneed-reviews";
import { FAQ as LeadStackFAQ } from "@/components/landing/faq";
import { CTA as LeadStackCTA } from "@/components/landing/cta";
import { Footer as LeadStackFooter } from "@/components/landing/footer";
import { ExitIntentModal } from "@/components/landing/exit-intent-modal";
import { CheckoutReturnModal } from "@/components/landing/checkout-return-modal";
import { UpdatesModal } from "@/components/landing/updates-modal";
import { SalesPopup } from "@/components/landing/sales-popup";
import { LiveVisitorBeacon } from "@/components/landing/live-visitor-beacon";

import { Navbar as CustomNavbar } from "@/components/landing-custom/navbar";
import { Hero as CustomHero } from "@/components/landing-custom/hero";
import { Features as CustomFeatures } from "@/components/landing-custom/features";
import { FAQ as CustomFAQ } from "@/components/landing-custom/faq";
import { CTA as CustomCTA } from "@/components/landing-custom/cta";
import { Footer as CustomFooter } from "@/components/landing-custom/footer";

/**
 * Renders the landing page for LANDING_VARIANT (src/config/landing.ts).
 * "custom" (the buyer template default): generic agency-CRM landing, brand
 * from the agency doc with CUSTOM_BRAND as fallback. "leadstack": the
 * leadstack.dev marketing page.
 */
export default async function HomePage() {
  if (LANDING_VARIANT === "custom") {
    const brand = await resolveCustomBrand();
    return (
      <div className="flex min-h-screen flex-col">
        <CustomNavbar brand={brand} />
        <main className="flex-1">
          <CustomHero brand={brand} />
          <CustomFeatures />
          <CustomFAQ brand={brand} />
          <CustomCTA brand={brand} />
        </main>
        <CustomFooter brand={brand} />
      </div>
    );
  }

  const heroVariant = await resolveHeroVariant();

  // Resolved server-side so the section never flashes. Only fetch the aggregate
  // when enabled, only render with at least one placeable buyer.
  const buyerMap = await getBuyerMapConfigCached();
  const buyerMapData = buyerMap.enabled
    ? await getBuyerMapData(buyerMap.minCityBuyers)
    : null;
  // The buyer count behind the savings figure never goes to the client.
  const buyerMapSavings =
    buyerMap.enabled && buyerMap.showSavings
      ? await getBuyerSavings(buyerMap.annualSavingsPerBuyer)
      : 0;
  const showBuyerMap =
    buyerMap.enabled && !!buyerMapData && buyerMapData.countries.length > 0;

  // Server-resolved so the first paint has the right price. Otherwise the client
  // starts from "deal is live" defaults and the price visibly jumps once
  // Firestore connects. The live subscription still runs underneath.
  const dealState = await getDealStateCached();

  return (
    <DealStateProvider
      value={dealState ? { cohort: dealState, nowMs: Date.now() } : null}
    >
      <div className="flex min-h-screen flex-col">
        {/* JSON-LD, server-rendered so crawlers get it in the first byte. */}
        <HomeSchema dealState={dealState} />
        <AnnouncementBar />
        <LeadStackNavbar />
        <main className="flex-1">
          <LeadStackHero variant={heroVariant} />
          {/* Answer-first definition block: the first extractable paragraph after the hero. */}
          <WhatIsLeadStack />
          <HowItWorks />
          <WorkspaceTour />
          <LeadStackFeatures />
          <MidPageCta />
          <Comparison />
          {/* <Support />, hidden for now; uncomment to restore */}
          <MakeItYours />
          <UneedReviews />
          {showBuyerMap && buyerMapData && (
            <BuyerWorldMap
              eyebrow={buyerMap.eyebrow}
              headingLead={buyerMap.headingLead}
              headingEmphasis={buyerMap.headingEmphasis}
              data={buyerMapData}
              showSavings={buyerMap.showSavings}
              savings={buyerMapSavings}
            />
          )}
          <LeadStackPricing />
          <TestimonialsCarousel />
          <IntegrationsCarousel />
          <LeadStackFAQ />
          <LeadStackCTA />
        </main>
        <LeadStackFooter variant={heroVariant} />
        <CheckoutReturnModal />
        <ExitIntentModal />
        <UpdatesModal />
        <SalesPopup />
        <LiveVisitorBeacon />
      </div>
    </DealStateProvider>
  );
}
