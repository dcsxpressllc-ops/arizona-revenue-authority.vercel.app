import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import type { SocialPostDoc } from "@/types";

/**
 * Delete a Social Planner post (admin only). A pending QStash job no-ops
 * once the doc is gone, so this is a safe cancel. Published posts only leave
 * the calendar; the live FB/IG post is not removed.
 */
export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string; postId: string }> },
) {
  const { id: subAccountId, postId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const db = getAdminDb();
  const ref = db.doc(`socialPosts/${postId}`);
  const snap = await ref.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Post not found" }, { status: 404 });
  }
  const post = snap.data() as Omit<SocialPostDoc, "id">;
  if (post.subAccountId !== subAccountId) {
    return NextResponse.json({ error: "Post not found" }, { status: 404 });
  }

  await ref.delete();
  return NextResponse.json({ ok: true, id: postId });
}
