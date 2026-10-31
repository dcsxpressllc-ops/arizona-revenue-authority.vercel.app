import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import {
  sanitizeProductPayload,
  type CreateProductPayload,
} from "@/lib/products/sanitize";
import {
  SellOnlineError,
  prepareSellOnlineUpdate,
} from "@/lib/server/products-sell-online-service";
import { DEFAULT_PRODUCT } from "@/types/products";
import type { Product } from "@/types/products";
import type { SubAccountDoc } from "@/types/tenancy";

export const dynamic = "force-dynamic";

/**
 * POST /api/sub-accounts/[id]/products
 * Body: { name, unitPriceCents, description?, currency?, active?, sell-online fields? } -> { id }
 * Any active member can create one, so a collaborator drafting an invoice
 * can add a missing product. Images are added afterwards via /images.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: subAccountId } = await params;

  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: CreateProductPayload & Record<string, unknown>;
  try {
    body = (await request.json()) as CreateProductPayload &
      Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const sanitized = sanitizeProductPayload(body);
  if (!sanitized.name) {
    return NextResponse.json(
      { error: "name is required" },
      { status: 400 },
    );
  }

  const db = getAdminDb();
  const subSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  const sub = (subSnap.data() ?? {}) as Partial<SubAccountDoc>;
  const agencyId = access.agencyId ?? (sub.agencyId as string | undefined);
  if (!agencyId) {
    return NextResponse.json(
      { error: "Sub-account is missing an agencyId" },
      { status: 500 },
    );
  }

  const docRef = db.collection("products").doc();
  let sell: Partial<Product>;
  try {
    sell = await prepareSellOnlineUpdate({
      db,
      subAccountId,
      sub,
      productId: docRef.id,
      existing: null,
      baseUpdates: sanitized,
      body,
    });
  } catch (err) {
    if (err instanceof SellOnlineError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  const doc: Omit<Product, "id"> = {
    ...DEFAULT_PRODUCT,
    agencyId,
    subAccountId,
    createdByUid: access.uid,
    ...sanitized,
    ...sell,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };

  try {
    await docRef.set(doc);
  } catch (err) {
    console.error("[products/create] write failed", err);
    return NextResponse.json(
      { error: "Failed to create product" },
      { status: 500 },
    );
  }

  return NextResponse.json({ id: docRef.id }, { status: 201 });
}
