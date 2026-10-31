import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";
import { Providers } from "@/components/providers";
import { RefTracker } from "@/components/affiliate/ref-tracker";
import { AnalyticsScripts } from "@/components/analytics-scripts";
import { SwRegister } from "@/components/pwa/sw-register";
import { PwaLinks } from "@/components/pwa/pwa-links";
import { CUSTOM_BRAND, LANDING_VARIANT } from "@/config/landing";
import { SITE_URL } from "@/components/landing/landing-meta";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const instrumentSerif = Instrument_Serif({
  variable: "--font-instrument-serif",
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
});

// Metadata follows the landing variant; "custom" derives title/description
// from CUSTOM_BRAND so one config file brands both.
// SITE_URL is the fixed www host on the LeadStack site (see landing-meta.ts
// for why it isn't the app URL); buyer clones use NEXT_PUBLIC_APP_URL.
const SITE_ORIGIN = SITE_URL;

// A malformed NEXT_PUBLIC_APP_URL must never break a buyer's build, so fall
// back to localhost.
function safeMetadataBase(origin: string): URL {
  try {
    return new URL(origin);
  } catch {
    return new URL("http://localhost:3000");
  }
}

const LEADSTACK_TITLE = "LeadStack — Own Your CRM, Never Rent It Again";
const LEADSTACK_DESCRIPTION =
  "LeadStack is the self-hosted white-label CRM for agencies: a GoHighLevel alternative sold as a one-time licence. Unlimited sub-accounts, AI agents, your code and your data — no monthly rent.";

export const metadata: Metadata = {
  // Without metadataBase, Next.js resolves OG/canonical URLs against localhost
  // in production.
  metadataBase: safeMetadataBase(SITE_ORIGIN),
  ...(LANDING_VARIANT === "custom"
    ? {
        title: `${CUSTOM_BRAND.name} — ${CUSTOM_BRAND.tagline}`,
        description: CUSTOM_BRAND.shortDescription,
        openGraph: {
          type: "website",
          siteName: CUSTOM_BRAND.name,
          title: `${CUSTOM_BRAND.name} — ${CUSTOM_BRAND.tagline}`,
          description: CUSTOM_BRAND.shortDescription,
        },
      }
    : {
        title: LEADSTACK_TITLE,
        description: LEADSTACK_DESCRIPTION,
        // www is the host Google indexed; keeps apex and www from competing.
        alternates: { canonical: "/" },
        openGraph: {
          type: "website",
          siteName: "LeadStack",
          url: "/",
          title: LEADSTACK_TITLE,
          description: LEADSTACK_DESCRIPTION,
          locale: "en_US",
        },
        twitter: {
          card: "summary_large_image",
          site: "@ambITious_apps",
          creator: "@ambITious_apps",
          title: LEADSTACK_TITLE,
          description: LEADSTACK_DESCRIPTION,
        },
      }),
  // Favicon per deployment mode. Both marks live in /public because an
  // app/icon.svg file would override this metadata.
  // PWA manifest only on custom-branded deployments; in "leadstack" mode the app
  // isn't the buyer's brand, so no install prompt. The apple icon goes through
  // the route so an owner upload applies (302s to the static PNG until then).
  ...(LANDING_VARIANT === "custom"
    ? {
        manifest: "/manifest.webmanifest",
        icons: {
          icon: "/mycrm-mark.svg",
          apple: "/api/pwa/icon/apple",
        },
        appleWebApp: {
          capable: true,
          title: CUSTOM_BRAND.name,
          statusBarStyle: "default" as const,
        },
      }
    : {
        icons: { icon: "/leadstack-mark.svg" },
      }),
};

export const viewport: Viewport = {
  themeColor: "#18181b",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${instrumentSerif.variable} antialiased`}
      >
        {process.env.NEXT_PUBLIC_GTM_ID && (
          <noscript>
            <iframe
              src={`https://www.googletagmanager.com/ns.html?id=${process.env.NEXT_PUBLIC_GTM_ID}`}
              height="0"
              width="0"
              style={{ display: "none", visibility: "hidden" }}
            />
          </noscript>
        )}
        <Providers>{children}</Providers>
        <SwRegister />
        <PwaLinks />
        <RefTracker />
        {process.env.NEXT_PUBLIC_META_PIXEL_ID && (
          <noscript>
            {/* Meta Pixel no-JS fallback has to be a bare <img>; next/image needs JS. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              height="1"
              width="1"
              style={{ display: "none" }}
              alt=""
              src={`https://www.facebook.com/tr?id=${process.env.NEXT_PUBLIC_META_PIXEL_ID}&ev=PageView&noscript=1`}
            />
          </noscript>
        )}
        <AnalyticsScripts />
      </body>
    </html>
  );
}
