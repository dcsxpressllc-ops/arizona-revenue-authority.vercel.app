import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { getFirstAgencyId } from "@/lib/pwa/icons-server";
import {
  ICON_STATIC_FALLBACKS,
  type IconVariantKey,
} from "@/lib/pwa/icon-variants";

/**
 * Icon endpoint for the manifest and apple-touch link. Serves the agency's
 * uploaded icon, else 302s to the static mark in /public. Public path:
 * installers fetch icons without credentials, and it's only branding.
 */

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  ctx: { params: Promise<{ variant: string }> },
) {
  const { variant } = await ctx.params;
  const fallback = ICON_STATIC_FALLBACKS[variant as IconVariantKey];
  if (!fallback) {
    return NextResponse.json({ error: "Unknown icon variant" }, { status: 404 });
  }

  try {
    const agencyId = await getFirstAgencyId();
    if (agencyId) {
      const snap = await getAdminDb()
        .doc(`agencies/${agencyId}/pwaIcons/${variant}`)
        .get();
      const png = snap.data()?.png as string | undefined;
      if (png) {
        return new NextResponse(Buffer.from(png, "base64"), {
          headers: {
            "Content-Type": "image/png",
            // The manifest busts with ?v=<upload millis>; an hour bounds staleness for
            // unversioned consumers.
            "Cache-Control": "public, max-age=3600",
          },
        });
      }
    }
  } catch {
    // Fall through to the static mark; icon requests never 500.
  }

  return NextResponse.redirect(new URL(fallback, request.url), 302);
}
