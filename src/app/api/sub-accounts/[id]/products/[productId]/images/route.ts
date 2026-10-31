import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import {
  MAX_PRODUCT_IMAGE_BYTES,
  ProductImageStorageError,
  deleteProductImageFile,
  saveProductImage,
} from "@/lib/server/product-images-storage";
import { IMAGE_ALT_MAX } from "@/lib/products/sell-online";
import { queueProductsChanged } from "@/lib/server/products-sync-service";
import { MAX_PRODUCT_IMAGES, type Product, type ProductImage } from "@/types/products";

export const dynamic = "force-dynamic";

/**
 * POST multipart { file, alt? }: adds one image to a product (max 6). Same
 * access as editing the product. The file goes to Storage first, then a
 * transaction appends it, so two parallel uploads can't exceed the cap; a
 * loser's file is removed again.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; productId: string }> },
) {
  const { id: subAccountId, productId } = await params;
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const db = getAdminDb();
  const ref = db.doc(`products/${productId}`);
  const snap = await ref.get();
  const product = snap.data() as Partial<Product> | undefined;
  if (!snap.exists || product?.subAccountId !== subAccountId) {
    return NextResponse.json({ error: "Product not found" }, { status: 404 });
  }
  if ((product.images?.length ?? 0) >= MAX_PRODUCT_IMAGES) {
    return NextResponse.json(
      { error: `A product can have up to ${MAX_PRODUCT_IMAGES} images.` },
      { status: 400 },
    );
  }

  let file: File | null = null;
  let alt = "";
  try {
    const form = await request.formData();
    const f = form.get("file");
    if (f instanceof File) file = f;
    const a = form.get("alt");
    if (typeof a === "string") alt = a.trim().slice(0, IMAGE_ALT_MAX);
  } catch {
    return NextResponse.json({ error: "Invalid upload" }, { status: 400 });
  }
  if (!file) return NextResponse.json({ error: "No file" }, { status: 400 });
  if (file.size > MAX_PRODUCT_IMAGE_BYTES) {
    return NextResponse.json(
      { error: "Image is too large, keep it under 5 MB." },
      { status: 400 },
    );
  }

  let saved;
  let onSale = false;
  try {
    saved = await saveProductImage({
      subAccountId,
      productId,
      buffer: Buffer.from(await file.arrayBuffer()),
    });
  } catch (err) {
    if (err instanceof ProductImageStorageError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[products/images] upload failed", err);
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }

  const image: ProductImage = {
    id: saved.id,
    url: saved.url,
    path: saved.path,
    source: "upload",
    alt: alt || product.name || "",
    width: saved.width,
    height: saved.height,
    createdAt: Date.now(),
  };

  try {
    await db.runTransaction(async (tx) => {
      const fresh = await tx.get(ref);
      const images = ((fresh.data() as Partial<Product>)?.images ?? []).slice();
      if (images.length >= MAX_PRODUCT_IMAGES) {
        throw new ProductImageStorageError(
          `A product can have up to ${MAX_PRODUCT_IMAGES} images.`,
          400,
        );
      }
      const p = fresh.data() as Partial<Product>;
      onSale = p.sellOnline === true;
      tx.update(ref, {
        images: [...images, image],
        // Clear a failed generation note; an upload answers it.
        ...(p.imageGeneration?.status === "failed" ? { imageGeneration: null } : {}),
        ...(p.sellOnline === true
          ? { publicVersion: (p.publicVersion ?? 0) + 1 }
          : {}),
        updatedAt: FieldValue.serverTimestamp(),
      });
    });
  } catch (err) {
    await deleteProductImageFile(subAccountId, productId, saved.path);
    if (err instanceof ProductImageStorageError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[products/images] attach failed", err);
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }

  if (onSale) {
    await queueProductsChanged({ subAccountId, productId, reason: "updated" }).catch(() => {});
  }
  return NextResponse.json({ ok: true, image }, { status: 201 });
}
