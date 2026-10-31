import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { removeCalendarConnection } from "@/lib/google/calendar-import";

/**
 * DELETE /api/sub-accounts/[id]/calendar-sync: disconnect yourself, or
 * `?uid=<uid>` for an admin disconnecting another member. Best-effort token
 * revoke at Google, then both docs are deleted. Already-pushed Google events
 * stay; wiping someone's calendar history on disconnect would be surprising.
 * No GET: the UI reads `calendarConnections` via the client SDK.
 */
export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const access = await requireSubAccountMember(request, id);
  if (access instanceof NextResponse) return access;

  const url = new URL(request.url);
  const targetUid = url.searchParams.get("uid") ?? access.uid;
  if (targetUid !== access.uid) {
    const isAdmin =
      access.subAccountRole === "admin" ||
      access.subAccountRole === "agencyOwner";
    if (!isAdmin) {
      return NextResponse.json(
        { error: "Only admins can disconnect another member's calendar." },
        { status: 403 },
      );
    }
  }

  // Imported Google events go with the connection; pushed copies stay.
  await removeCalendarConnection(id, targetUid);

  return NextResponse.json({ ok: true });
}
