import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { getAdminDb } from "@/lib/firebase/admin";
import { updateGroupServerSide } from "@/lib/server/community-service";
import { parseVideoUrl } from "@/lib/community/video-embed";
import type {
  GroupAccess,
  GroupJoinPolicy,
  GroupMode,
  GroupStatus,
  ResourceLink,
} from "@/types/community";

export const dynamic = "force-dynamic";

async function requireCommunityAdmin(request: Request, subAccountId: string) {
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;
  const subSnap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  if (subSnap.data()?.communityEnabledByAgency !== true) {
    return NextResponse.json(
      { error: "Community is disabled for this sub-account." },
      { status: 403 },
    );
  }
  return access;
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string; groupId: string }> },
) {
  const { id: subAccountId, groupId } = await ctx.params;
  const access = await requireCommunityAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: {
    name?: string;
    about?: string;
    tagline?: string;
    coverUrl?: string | null;
    cardImageUrl?: string | null;
    logoUrl?: string | null;
    brandColor?: string | null;
    access?: GroupAccess;
    priceCents?: number | null;
    currency?: string | null;
    mode?: GroupMode;
    salesVideoUrl?: string | null;
    joinPolicy?: GroupJoinPolicy;
    status?: GroupStatus;
    categories?: string[];
    links?: ResourceLink[];
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Reject an unembeddable promo-video URL instead of silently clearing it.
  if (
    typeof body.salesVideoUrl === "string" &&
    body.salesVideoUrl.trim() &&
    !parseVideoUrl(body.salesVideoUrl)
  ) {
    return NextResponse.json(
      { error: "Enter a YouTube or Vimeo video URL." },
      { status: 400 },
    );
  }

  const group = await updateGroupServerSide({
    subAccountId,
    groupId,
    patch: body,
  });
  if (!group) {
    return NextResponse.json({ error: "Group not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, group });
}

/** Deletes the group doc only; subcollections are not cascaded. */
export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string; groupId: string }> },
) {
  const { id: subAccountId, groupId } = await ctx.params;
  const access = await requireCommunityAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  await getAdminDb()
    .doc(`subAccounts/${subAccountId}/communityGroups/${groupId}`)
    .delete();
  return NextResponse.json({ ok: true });
}
