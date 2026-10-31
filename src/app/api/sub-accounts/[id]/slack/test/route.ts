import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { SlackError, sendSlackTest } from "@/lib/server/slack-service";
import { invalidateSlackHookCache } from "@/lib/slack/events";

/** Re-sends the "connected" message so an admin can confirm the channel. */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const auth = await requireSubAccountAdmin(request, id);
  if (auth instanceof NextResponse) return auth;
  try {
    const config = await sendSlackTest(id);
    invalidateSlackHookCache(id);
    return NextResponse.json({ ok: true, config });
  } catch (err) {
    if (err instanceof SlackError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[slack/test] failed", err);
    return NextResponse.json({ error: "Test failed" }, { status: 500 });
  }
}
