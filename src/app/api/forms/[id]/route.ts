import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";

/**
 * Delete a form and its submissions subcollection. A client-SDK deleteDoc
 * leaves `forms/{id}/submissions/*` behind, and those orphans (indexed by
 * contactId) block contact deletion. recursiveDelete wipes both.
 *
 * Auth: any active member of the form's sub-account. `/api/forms` is a
 * middleware PUBLIC_PATH (for submit), so auth is enforced here; no
 * x-user-uid means 401.
 */
export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const db = getAdminDb();
  const ref = db.doc(`forms/${id}`);
  const snap = await ref.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Form not found" }, { status: 404 });
  }
  const subAccountId = snap.data()!.subAccountId as string;

  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  await db.recursiveDelete(ref);
  return NextResponse.json({ ok: true, formId: id });
}
