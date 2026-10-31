import "server-only";

import { NextResponse } from "next/server";
import { getAdminAuth, getAdminDb } from "@/lib/firebase/admin";
import { seedDemo, unseedDemo } from "@/lib/seed/demo-data";
import { LANDING_VARIANT } from "@/config/landing";
import type { MemberStatus, Role } from "@/types";

/**
 * Seeds the public demo sub-account (#1004, looked up by accountNumber).
 * Only when LANDING_VARIANT is "leadstack" (404 otherwise), agency owner only.
 *
 *   POST   -> 300 contacts, ~80 deals, activities
 *   DELETE -> removes every tag-"seed" contact and their deals
 */

interface CallerClaims {
  role?: Role;
  status?: MemberStatus;
  agencyRole?: "owner" | "staff" | null;
  agencyId?: string | null;
}

async function requireOwnerOrReject(
  request: Request,
): Promise<{ uid: string } | NextResponse> {
  // Variant gate first so other installs just see a 404.
  if (LANDING_VARIANT !== "leadstack") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const uid = request.headers.get("x-user-uid");
  if (!uid) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const record = await getAdminAuth().getUser(uid).catch(() => null);
  if (!record) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const claims = (record.customClaims ?? {}) as CallerClaims;
  if (claims.status !== "active") {
    return NextResponse.json({ error: "Account inactive" }, { status: 403 });
  }
  if (claims.agencyRole !== "owner" || !claims.agencyId) {
    return NextResponse.json(
      { error: "Only the agency owner can run the demo seeder." },
      { status: 403 },
    );
  }
  return { uid };
}

export async function POST(request: Request) {
  const access = await requireOwnerOrReject(request);
  if (access instanceof NextResponse) return access;

  try {
    const result = await seedDemo(getAdminDb());
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Seed failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const access = await requireOwnerOrReject(request);
  if (access instanceof NextResponse) return access;

  try {
    const result = await unseedDemo(getAdminDb());
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unseed failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
