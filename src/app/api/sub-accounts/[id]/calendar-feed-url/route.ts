import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import {
  buildCalendarFeedUrl,
  buildHostCalendarFeedUrl,
} from "@/lib/booking/calendar-feed-token";

/**
 * The caller's signed calendar feed URLs (any active member).
 * url: every booking in the sub-account. hostUrl: only the caller's
 * bookings; uid comes from the session, so members can only mint their own.
 * Tokens derive from AUTOMATIONS_TOKEN_SECRET, so clients can't build them.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  try {
    const url = buildCalendarFeedUrl(subAccountId);
    const hostUrl = buildHostCalendarFeedUrl(subAccountId, access.uid);
    return NextResponse.json({ url, hostUrl });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    return NextResponse.json(
      {
        error:
          "Couldn't mint a calendar feed URL. Check that AUTOMATIONS_TOKEN_SECRET is configured on this deployment.",
        detail: message,
      },
      { status: 500 },
    );
  }
}
