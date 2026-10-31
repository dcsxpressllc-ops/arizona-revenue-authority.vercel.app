import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { sanitizeProductPayload } from "@/lib/products/sanitize";
import {
  SellOnlineError,
  prepareSellOnlineUpdate,
  reorderImages,
} from "@/lib/server/products-sell-online-service";
import { deleteProductImageFolder } from "@/lib/server/product-images-storage";
import { requestProductImageGeneration } from "@/lib/server/product-images-service";
import { runAfterResponse } from "@/lib/server/after-response";
import { queueProductsChanged } from "@/lib/server/products-sync-service";
import type { Product } from "@/types/products";
import type { SubAccountDoc } from "@/types/tenancy";

export const dynamic = "force-dynamic";

/**
 * PATCH/DELETE one product; caller must be a member of its sub-account.
 * PATCH: partial update of catalog fields, sell-online fields (gated, see
 * products-sell-online-service) and image order/alt text.
 * DELETE: soft delete (active = false); snapshotted line items are
 * unaffected. `?hard=true` really deletes, only safe if no quote uses it.
 */

async function loadProductAndAuth(
  request: Request,
  subAccountId: string,
  productId: string,
) {
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return { error: access };

  const db = getAdminDb();
  const snap = await db.doc(`products/${productId}`).get();
  if (!snap.exists) {
    return {
      error: NextResponse.json({ error: "Product not found" }, { status: 404 }),
    };
  }
  const data = snap.data() ?? {};
  if (data.subAccountId !== subAccountId) {
    return {
      error: NextResponse.json(
        { error: "Product belongs to a different sub-account" },
        { status: 403 },
      ),
    };
  }
  return { access, db, ref: snap.ref, product: data as Partial<Product> };
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; productId: string }> },
) {
  const { id: subAccountId, productId } = await params;
  const loaded = await loadProductAndAuth(request, subAccountId, productId);
  if ("error" in loaded) return loaded.error;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const updates: Partial<Product> = sanitizeProductPayload(body);
  const wantsImages = body.images !== undefined;
  try {
    // Shape check now; the real reorder runs inside the write transaction.
    if (wantsImages) reorderImages(loaded.product.images, body.images);
    const subSnap = await loaded.db.doc(`subAccounts/${subAccountId}`).get();
    const sell = await prepareSellOnlineUpdate({
      db: loaded.db,
      subAccountId,
      sub: (subSnap.data() ?? {}) as Partial<SubAccountDoc>,
      productId,
      existing: loaded.product,
      baseUpdates: updates,
      body,
    });
    Object.assign(updates, sell);
  } catch (err) {
    if (err instanceof SellOnlineError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  if (Object.keys(updates).length === 0 && !wantsImages) {
    // Unchanged sell-online values (e.g. a round-trip with the gate off) are a
    // no-op, not an error.
    const sellKeys = ["sellOnline", "slug", "publicDescription", "checkoutPageId", "delivery"];
    if (sellKeys.some((k) => k in body)) return NextResponse.json({ ok: true });
    return NextResponse.json(
      { error: "No valid fields to update" },
      { status: 400 },
    );
  }

  let bumped = updates.publicVersion !== undefined;
  try {
    if (wantsImages) {
      // Re-read inside the transaction so a parallel upload or delete can't be
      // dropped or resurrected by a reorder computed from a stale list.
      await loaded.db.runTransaction(async (tx) => {
        const fresh = (await tx.get(loaded.ref)).data() as Partial<Product>;
        const images = reorderImages(fresh.images, body.images);
        const bump =
          fresh.sellOnline === true && updates.publicVersion === undefined
            ? { publicVersion: (fresh.publicVersion ?? 0) + 1 }
            : {};
        if ("publicVersion" in bump) bumped = true;
        tx.update(loaded.ref, {
          ...updates,
          images,
          ...bump,
          updatedAt: FieldValue.serverTimestamp(),
        });
      });
    } else {
      await loaded.ref.update({
        ...updates,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
  } catch (err) {
    if (err instanceof SellOnlineError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[products/update] write failed", err);
    return NextResponse.json(
      { error: "Failed to update product" },
      { status: 500 },
    );
  }

  // A product that was on the website changed in a way visitors see: re-sync
  // the live shop pages. Newly listed products are added by the site's owner.
  if (bumped && loaded.product.sellOnline === true) {
    await queueProductsChanged({
      subAccountId,
      productId,
      reason:
        updates.sellOnline === false
          ? "unlisted"
          : updates.active === false
            ? "archived"
            : "updated",
    }).catch((err) => console.warn("[products/update] sync notice failed", err));
  }

  // Just put on sale with no picture: start an AI image after the response.
  if (updates.sellOnline === true && !(loaded.product.images?.length)) {
    runAfterResponse(() =>
      requestProductImageGeneration({ subAccountId, productId, auto: true }),
    );
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; productId: string }> },
) {
  const { id: subAccountId, productId } = await params;
  const url = new URL(request.url);
  const hard = url.searchParams.get("hard") === "true";

  const loaded = await loadProductAndAuth(request, subAccountId, productId);
  if ("error" in loaded) return loaded.error;

  try {
    if (hard) {
      await loaded.ref.delete();
    } else {
      await loaded.ref.update({
        active: false,
        // Archiving takes it off the website, so resyncs must not skip it.
        ...(loaded.product.sellOnline === true
          ? { publicVersion: (loaded.product.publicVersion ?? 0) + 1 }
          : {}),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
  } catch (err) {
    console.error("[products/delete] failed", err);
    return NextResponse.json(
      { error: "Failed to delete product" },
      { status: 500 },
    );
  }

  if (loaded.product.sellOnline === true) {
    await queueProductsChanged({ subAccountId, productId, reason: "archived" }).catch((err) =>
      console.warn("[products/delete] sync notice failed", err),
    );
  }

  // Archived products keep their images so restoring brings them back.
  if (hard) await deleteProductImageFolder(subAccountId, productId);

  return NextResponse.json({ ok: true });
}
