import "server-only";

import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import {
  buildMetaOAuthUrl,
  metaAppConfigured,
  metaRedirectUri,
  metaScopeList,
  signMetaState,
} from "@/lib/comms/meta";
import type { SubAccountDoc } from "@/types";

/**
 * GET /api/sub-accounts/[id]/meta/connect: starts Facebook/Instagram connect.
 * One connection serves both the inbox and the Social Planner.
 *
 * Admin only. Needs `metaInboxEnabledByAgency` or
 * `socialPlannerEnabledByAgency` plus a configured Meta app; publishing
 * scopes are only requested with the Social gate on. Redirects to Facebook
 * Login, or back to Settings with `?meta=...` when a guard fails.
 */

function appBase(request: Request): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL ?? new URL(request.url).origin
  ).replace(/\/$/, "");
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const access = await requireSubAccountAdmin(request, id);
  if (access instanceof NextResponse) return access;

  const settingsUrl = new URL(
    `/sa/${id}/dashboard/settings`,
    appBase(request),
  );

  const snap = await getAdminDb().doc(`subAccounts/${id}`).get();
  const sa = snap.exists ? (snap.data() as SubAccountDoc) : null;

  // Either gate unlocks it; publishing scopes only with the Social gate.
  const inboxOn = sa?.metaInboxEnabledByAgency === true;
  const socialOn = sa?.socialPlannerEnabledByAgency === true;
  if (!inboxOn && !socialOn) {
    settingsUrl.searchParams.set("meta", "gate_off");
    return NextResponse.redirect(settingsUrl);
  }

  if (!metaAppConfigured()) {
    settingsUrl.searchParams.set("meta", "not_configured");
    return NextResponse.redirect(settingsUrl);
  }

  // One redirect URI per deployment; the sub-account rides in signed `state`.
  const redirectUri = metaRedirectUri();
  if (!redirectUri) {
    settingsUrl.searchParams.set("meta", "not_configured");
    return NextResponse.redirect(settingsUrl);
  }

  const nonce = crypto.randomBytes(16).toString("hex");
  const state = signMetaState(id, nonce);
  return NextResponse.redirect(
    buildMetaOAuthUrl({
      redirectUri,
      state,
      scope: metaScopeList({ publish: socialOn }),
    }),
  );
}
