import { NextResponse } from "next/server";
import { logoDocRef, type LogoScope } from "@/lib/brand/logo-server";

/**
 * Public logo endpoint behind every uploaded `logoUrl`. Public because email
 * clients and visitors fetch it without credentials, and it's only branding.
 * The URL carries ?v=<upload millis>, so long immutable caching is safe.
 */

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ scope: string; id: string }> },
) {
  const { scope, id } = await ctx.params;
  if ((scope !== "agency" && scope !== "sa") || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const snap = await logoDocRef(scope as LogoScope, id).get();
    const data = snap.data();
    const b64 = data?.data as string | undefined;
    const mime = data?.mime as string | undefined;
    if (b64 && (mime === "image/png" || mime === "image/webp")) {
      return new NextResponse(Buffer.from(b64, "base64"), {
        headers: {
          "Content-Type": mime,
          // s-maxage lets the CDN absorb repeat hits instead of Firestore.
          "Cache-Control":
            "public, max-age=31536000, s-maxage=31536000, immutable",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
  } catch {
    // Fall through to 404; logo requests never 500.
  }
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}
