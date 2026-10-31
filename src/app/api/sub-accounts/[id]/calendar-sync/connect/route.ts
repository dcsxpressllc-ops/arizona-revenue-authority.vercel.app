import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import {
  buildGoogleOAuthUrl,
  googleCalendarConfigured,
  googleRedirectUri,
  signCalendarState,
} from "@/lib/google/calendar";

/**
 * GET /api/sub-accounts/[id]/calendar-sync/connect: starts Google Calendar
 * OAuth for the calling member. Any active member can connect their own
 * account (it only exposes their busy blocks). Sub-account and uid ride in
 * the signed `state` so the single redirect URI binds tokens to the right
 * person. 302 to consent; 503 if GOOGLE_OAUTH_CLIENT_ID/SECRET are unset.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const access = await requireSubAccountMember(request, id);
  if (access instanceof NextResponse) return access;

  if (!googleCalendarConfigured()) {
    return NextResponse.json(
      {
        error:
          "Google Calendar sync isn't configured on this deployment. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET.",
      },
      { status: 503 },
    );
  }
  const redirectUri = googleRedirectUri();
  if (!redirectUri) {
    return NextResponse.json(
      { error: "NEXT_PUBLIC_APP_URL must be set to connect Google Calendar." },
      { status: 503 },
    );
  }

  const state = signCalendarState(id, access.uid);
  return NextResponse.redirect(buildGoogleOAuthUrl({ redirectUri, state }));
}
