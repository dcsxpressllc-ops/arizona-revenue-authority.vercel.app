import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { listRecentEventsWithDeliveries } from "@/lib/firestore/webhook-events";

/**
 * Data for the Logs -> Webhooks tab: recent emitted events with their
 * delivery attempts nested, newest first. Admin-only (responses and URLs).
 * `?limit=` events, clamped to 50; live/test filtering is client-side.
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
    const events = await listRecentEventsWithDeliveries(subAccountId, { limit });
    return NextResponse.json({ events });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(
      `[logs/webhook-deliveries] list failed sa=${subAccountId}`,
      err,
    );
    // Admin-only debug surface, so return the real cause for the toast.
    return NextResponse.json(
      { error: `Couldn't load webhook logs: ${detail}`, detail },
      { status: 500 },
    );
  }
}
