import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { listRequestLogs } from "@/lib/api/logs";

/**
 * Data for the Logs -> API tab: recent public-API request logs, newest first.
 * Admin-only, since excerpts can include request/response bodies.
 * `?limit=` is clamped to 200; live/test filtering happens client-side.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const url = new URL(request.url);
  const limitParam = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : undefined;

  try {
    const logs = await listRequestLogs(subAccountId, { limit });
    return NextResponse.json({ logs });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(
      `[logs/api-requests] list failed sa=${subAccountId}`,
      err,
    );
    // Admin-only debug surface, so return the real cause for the toast.
    return NextResponse.json(
      { error: `Couldn't load API logs: ${detail}`, detail },
      { status: 500 },
    );
  }
}
