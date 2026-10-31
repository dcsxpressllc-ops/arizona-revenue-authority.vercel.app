import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import {
  logoDocRef,
  logoPublicUrl,
  storeLogo,
  validateLogo,
} from "@/lib/brand/logo-server";
import { isUploadedLogoUrl } from "@/lib/brand/logo-shared";

/**
 * Sub-account logo upload/remove (admin or agency owner). Same flow as the
 * agency logo: store server-side, point `subAccount.logoUrl` at the public
 * serving route.
 */

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: { data?: unknown; mime?: unknown };
  try {
    body = (await request.json()) as { data?: unknown; mime?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const result = validateLogo(body.data, body.mime);
  if (typeof result === "string") {
    return NextResponse.json({ error: result }, { status: 400 });
  }

  const version = await storeLogo(
    "sa",
    subAccountId,
    result,
    body.mime as "image/png" | "image/webp",
  );
  const logoUrl = logoPublicUrl("sa", subAccountId, version, request);
  await getAdminDb().doc(`subAccounts/${subAccountId}`).set(
    { logoUrl, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );

  return NextResponse.json({ ok: true, logoUrl });
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const subRef = getAdminDb().doc(`subAccounts/${subAccountId}`);
  const snap = await subRef.get();
  await logoDocRef("sa", subAccountId).delete();
  // Leave a pasted URL alone; only clear the field when it points at our upload.
  if (isUploadedLogoUrl(snap.data()?.logoUrl as string | undefined)) {
    await subRef.update({
      logoUrl: null,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  return NextResponse.json({ ok: true });
}
