import "server-only";

import { NextResponse } from "next/server";
import { requireAgencyOwner } from "@/lib/auth/require-agency-owner";
import { GROUPS, evaluateGroup } from "@/lib/setup/catalog";
import { LANDING_VARIANT } from "@/config/landing";

/**
 * Setup summary for the Get-started banner. Owner-only but deliberately not
 * gated on the setup-form toggle, since its job is to point a new owner at
 * Guided setup. Returns counts and group titles only (no key names, no
 * values, no Vercel call).
 *
 * Tier "boot" groups at "error" make requiredComplete false; unconfigured or
 * partial "feature" groups count as remaining.
 */
export async function GET(request: Request) {
  const auth = await requireAgencyOwner(request);
  if (auth instanceof NextResponse) return auth;

  const getValue = (k: string) => process.env[k];
  const relevant = GROUPS.filter((g) => g.tier !== "preflight").filter(
    (g) => !g.variant || g.variant === LANDING_VARIANT,
  );

  let missingRequiredKeys = 0;
  const requiredIssues: string[] = [];
  let featuresConfigured = 0;
  const featuresRemaining: string[] = [];
  // For the setup-snapshot dialog. Titles, statuses and catalog copy only.
  const groups: {
    title: string;
    tier: string;
    status: string;
    off: string | null;
  }[] = [];

  for (const g of relevant) {
    const res = evaluateGroup(g, getValue);
    groups.push({
      title: g.title,
      tier: g.tier,
      status: res.status,
      off: g.off ?? null,
    });
    if (g.tier === "boot") {
      if (res.status === "error") {
        missingRequiredKeys += res.missingReq.length;
        requiredIssues.push(g.title);
      }
    } else if (res.status === "ok") {
      featuresConfigured += 1;
    } else {
      featuresRemaining.push(g.title);
    }
  }

  return NextResponse.json({
    ok: true,
    requiredComplete: requiredIssues.length === 0,
    missingRequiredKeys,
    requiredIssues,
    featuresConfigured,
    featuresTotal: featuresConfigured + featuresRemaining.length,
    featuresRemaining,
    groups,
  });
}
