import "server-only";

import { NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { runHealthChecks, type IntegrationHealth } from "@/lib/health/checks";
import type { AgencyRole, MemberStatus } from "@/types";

/**
 * Owner-only integration health, one row per integration. Cached in memory
 * for 60s; `?refresh=1` forces a re-check. Owner-only because it reveals
 * env-var presence.
 */

interface CacheEntry {
  results: IntegrationHealth[];
  cachedAt: number;
}

const CACHE_TTL_MS = 60 * 1000;
const cache = new Map<string, CacheEntry>();

interface CallerClaims {
  agencyId?: string | null;
  agencyRole?: AgencyRole | null;
  status?: MemberStatus;
}

async function readOwnerCaller(
  request: Request,
): Promise<{ agencyId: string } | NextResponse> {
  const uid = request.headers.get("x-user-uid");
  if (!uid) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const record = await getAdminAuth().getUser(uid);
  const claims = (record.customClaims ?? {}) as CallerClaims;
  if (claims.status !== "active") {
    return NextResponse.json({ error: "Account inactive" }, { status: 403 });
  }
  if (claims.agencyRole !== "owner" || !claims.agencyId) {
    return NextResponse.json(
      { error: "Agency owner only" },
      { status: 403 },
    );
  }
  return { agencyId: claims.agencyId };
}

export async function GET(request: Request) {
  const auth = await readOwnerCaller(request);
  if (auth instanceof NextResponse) return auth;

  const url = new URL(request.url);
  const refresh = url.searchParams.get("refresh") === "1";
  const cached = cache.get(auth.agencyId);
  if (
    cached &&
    !refresh &&
    Date.now() - cached.cachedAt < CACHE_TTL_MS
  ) {
    return NextResponse.json({
      results: cached.results,
      cachedAt: cached.cachedAt,
      fresh: false,
    });
  }

  const results = await runHealthChecks();
  const cachedAt = Date.now();
  cache.set(auth.agencyId, { results, cachedAt });
  return NextResponse.json({ results, cachedAt, fresh: true });
}
