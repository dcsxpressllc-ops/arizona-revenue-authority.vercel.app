import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireAgencyOwner } from "@/lib/auth/require-agency-owner";
import { getFirstAgencyId } from "@/lib/pwa/icons-server";
import {
  logoDocRef,
  logoPublicUrl,
  storeLogo,
  validateLogo,
} from "@/lib/brand/logo-server";
import { isUploadedLogoUrl } from "@/lib/brand/logo-shared";

/**
 * Owner-only agency logo upload/remove. The browser resizes the file
 * (lib/brand/render-logo-client.ts); we re-validate, store it, and point the
 * agency's existing `logoUrl` at the public serving route.
 */

export async function POST(request: Request) {
  const owner = await requireAgencyOwner(request);
  if (owner instanceof NextResponse) return owner;

  const agencyId = await getFirstAgencyId();
  if (!agencyId) {
    return NextResponse.json(
      { error: "No agency exists yet. Complete the first signup first." },
      { status: 409 },
    );
  }

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
    "agency",
    agencyId,
    result,
    body.mime as "image/png" | "image/webp",
  );
  const logoUrl = logoPublicUrl("agency", agencyId, version, request);
  await getAdminDb().doc(`agencies/${agencyId}`).update({
    logoUrl,
    updatedAt: FieldValue.serverTimestamp(),
  });

  return NextResponse.json({ ok: true, logoUrl });
}

export async function DELETE(request: Request) {
  const owner = await requireAgencyOwner(request);
  if (owner instanceof NextResponse) return owner;

  const agencyId = await getFirstAgencyId();
  if (!agencyId) return NextResponse.json({ ok: true });

  const db = getAdminDb();
  const agencyRef = db.doc(`agencies/${agencyId}`);
  const snap = await agencyRef.get();
  await logoDocRef("agency", agencyId).delete();
  // Leave a pasted URL alone; only clear the field when it points at our upload.
  if (isUploadedLogoUrl(snap.data()?.logoUrl as string | undefined)) {
    await agencyRef.update({
      logoUrl: null,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  return NextResponse.json({ ok: true });
}
