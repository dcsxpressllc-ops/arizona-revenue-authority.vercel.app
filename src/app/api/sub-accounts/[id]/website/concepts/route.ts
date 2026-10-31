import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import {
  fetchConcepts,
  GitpageError,
  gitpageIsConfigured,
} from "@/lib/gitpage/client";
import { isNicheKey } from "@/lib/website/niches";

export const dynamic = "force-dynamic";

/**
 * GET .../website/concepts?niche=gym_fitness
 * Proxies gitpage's GET /api/v1/concepts (three premium design directions
 * per niche) for the concept picker. Member auth; the gitpage key stays
 * server-side. No niche = generic concepts.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  if (!gitpageIsConfigured()) {
    return NextResponse.json(
      { error: "gitpage is not configured on this deployment (GITPAGE_API_KEY missing)." },
      { status: 503 },
    );
  }

  const url = new URL(request.url);
  const raw = url.searchParams.get("niche");
  const niche = raw && isNicheKey(raw) ? raw : null;
  if (raw && !niche) {
    return NextResponse.json({ error: "Unknown niche." }, { status: 400 });
  }

  try {
    const concepts = await fetchConcepts(niche);
    return NextResponse.json(
      { concepts },
      { headers: { "Cache-Control": "private, max-age=300" } },
    );
  } catch (err) {
    if (err instanceof GitpageError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.status >= 500 ? 502 : err.status },
      );
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not load concepts." },
      { status: 502 },
    );
  }
}
