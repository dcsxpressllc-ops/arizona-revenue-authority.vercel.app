import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { syncClientSitesFromGitpage } from "@/lib/server/website-import-service";

export const dynamic = "force-dynamic";

/**
 * POST .../website/sync: imports gitpage Duplicates this sub-account made
 * that the Websites list doesn't have yet (website-import-service.ts).
 * Called when the page opens. Admin-only. Fails quietly.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;
  try {
    const result = await syncClientSitesFromGitpage(subAccountId);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("[website sync] failed:", err);
    return NextResponse.json({ ok: false, imported: 0 }, { status: 200 });
  }
}
