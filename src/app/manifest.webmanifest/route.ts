import { NextResponse } from "next/server";
import { resolveCustomBrand } from "@/lib/landing/resolve-brand";
import { getPwaIconVersion } from "@/lib/pwa/icons-server";
import { ICON_STATIC_FALLBACKS } from "@/lib/pwa/icon-variants";
import { LANDING_VARIANT } from "@/config/landing";

/**
 * PWA manifest as a dynamic route (not app/manifest.ts) so branding is live.
 * "custom": name/description from the agency doc over CUSTOM_BRAND, linked
 * site-wide. "leadstack": fixed identity, only linked from auth pages
 * (pwa-links.tsx). An owner-uploaded icon serves from /api/pwa/icon/* with the
 * upload time as cache-buster; otherwise ICON_STATIC_FALLBACKS.
 * start_url /dashboard redirects to the first-membership sub-account (or /login).
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const isCustom = LANDING_VARIANT === "custom";
  const [brand, iconVersion] = await Promise.all([
    isCustom ? resolveCustomBrand() : Promise.resolve(null),
    getPwaIconVersion(),
  ]);

  const name = brand?.name ?? "LeadStack";
  const description =
    brand?.shortDescription ??
    "The all-in-one CRM for teams that actually close.";

  const icons = iconVersion
    ? [
        {
          src: `/api/pwa/icon/192?v=${iconVersion}`,
          sizes: "192x192",
          type: "image/png",
        },
        {
          src: `/api/pwa/icon/512?v=${iconVersion}`,
          sizes: "512x512",
          type: "image/png",
        },
        {
          src: `/api/pwa/icon/maskable?v=${iconVersion}`,
          sizes: "512x512",
          type: "image/png",
          purpose: "maskable",
        },
      ]
    : [
        {
          src: ICON_STATIC_FALLBACKS["192"],
          sizes: "192x192",
          type: "image/png",
        },
        {
          src: ICON_STATIC_FALLBACKS["512"],
          sizes: "512x512",
          type: "image/png",
        },
        {
          src: ICON_STATIC_FALLBACKS.maskable,
          sizes: "512x512",
          type: "image/png",
          purpose: "maskable",
        },
      ];

  const manifest = {
    name,
    short_name: name.length > 12 ? name.slice(0, 12) : name,
    description,
    id: "/",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    background_color: "#18181b",
    theme_color: "#18181b",
    icons,
    // Shortcut URLs must be static, so they use the legacy flat routes, which
    // redirect into the user's first sub-account.
    shortcuts: [
      {
        name: "Conversations",
        url: "/conversations",
        icons: [
          {
            src: ICON_STATIC_FALLBACKS["192"],
            sizes: "192x192",
            type: "image/png",
          },
        ],
      },
      {
        name: "Contacts",
        url: "/contacts",
        icons: [
          {
            src: ICON_STATIC_FALLBACKS["192"],
            sizes: "192x192",
            type: "image/png",
          },
        ],
      },
      {
        name: "Pipeline",
        url: "/pipeline",
        icons: [
          {
            src: ICON_STATIC_FALLBACKS["192"],
            sizes: "192x192",
            type: "image/png",
          },
        ],
      },
    ],
  };

  return NextResponse.json(manifest, {
    headers: {
      "Content-Type": "application/manifest+json",
      // Short cache: saves a Firestore read per load, renames still land in minutes.
      "Cache-Control": "public, max-age=300",
    },
  });
}
