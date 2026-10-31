import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import {
  createWebsiteForSubAccount,
  WebsiteServiceError,
} from "@/lib/server/websites-service";

/**
 * Creates a blank draft website and returns its id; the operator then fills
 * the form and builds via /website/[siteId]/build. Gate and per-sub-account
 * cap are enforced in the shared websites service (also used by AI Suite
 * `create_website`) so both entry points match.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  try {
    const { siteId } = await createWebsiteForSubAccount({ subAccountId });
    return NextResponse.json({ ok: true, siteId });
  } catch (err) {
    if (err instanceof WebsiteServiceError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[website/create] failed", err);
    return NextResponse.json(
      { error: "Failed to create the website." },
      { status: 500 },
    );
  }
}
