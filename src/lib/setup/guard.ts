import "server-only";

import { NextResponse } from "next/server";
import { requireAgencyOwner } from "@/lib/auth/require-agency-owner";
import { getAdminDb } from "@/lib/firebase/admin";

/**
 * Gating for the setup-form API routes: the caller must be the agency owner
 * and `appConfig/setup.formEnabled` must be on. `vercelConfigured()` is checked
 * per route, since a local `.env.local` write doesn't need Vercel creds.
 */

export const SETUP_DOC = "appConfig/setup";

export async function readFormEnabled(): Promise<boolean> {
  const snap = await getAdminDb().doc(SETUP_DOC).get();
  return snap.exists && snap.data()?.formEnabled === true;
}

/** Returns the owner, or a 401/403 NextResponse the route should return as-is. */
export async function requireSetupEnabled(request: Request) {
  const auth = await requireAgencyOwner(request);
  if (auth instanceof NextResponse) return auth;

  if (!(await readFormEnabled())) {
    return NextResponse.json(
      { error: "The setup form is disabled." },
      { status: 403 },
    );
  }
  return auth;
}
