import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { deleteProductImageFile } from "@/lib/server/product-images-storage";
import type { Product, ProductImage } from "@/types/products";
import { queueProductsChanged } from "@/lib/server/products-sync-service";

export const dynamic = "force-dynamic";

/** DELETE one product image: removes the entry, then the Storage file. */
export async function DELETE(
  request: Request,
  {
    params,
  }: { params: Promise<{ id: string; productId: string; imageId: string }> },
) {
  const { id: subAccountId, productId, imageId } = await params;
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const db = getAdminDb();
  const ref = db.doc(`products/${productId}`);
  let removed: ProductImage | null = null;
  let onSale = false;
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const p = snap.data() as Partial<Product> | undefined;
      if (!snap.exists || p?.subAccountId !== subAccountId) return;
      const images = p.images ?? [];
      removed = images.find((img) => img.id === imageId) ?? null;
      if (!removed) return;
      onSale = p.sellOnline === true;
      tx.update(ref, {
        images: images.filter((img) => img.id !== imageId),
        ...(p.sellOnline === true
          ? { publicVersion: (p.publicVersion ?? 0) + 1 }
          : {}),
        updatedAt: FieldValue.serverTimestamp(),
      });
    });
  } catch (err) {
    console.error("[products/images] delete failed", err);
    return NextResponse.json({ error: "Delete failed" }, { status: 500 });
  }

  if (!removed) {
    return NextResponse.json({ error: "Image not found" }, { status: 404 });
  }
  if (onSale) {
    await queueProductsChanged({ subAccountId, productId, reason: "updated" }).catch(() => {});
  }
  await deleteProductImageFile(
    subAccountId,
    productId,
    (removed as ProductImage).path,
  );
  return NextResponse.json({ ok: true });
}
