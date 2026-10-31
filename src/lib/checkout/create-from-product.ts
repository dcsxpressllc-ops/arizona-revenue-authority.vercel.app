import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { CheckoutPageError } from "@/lib/checkout/sanitize";
import {
  isReservedCheckoutSlug,
  slugifyCheckoutSlug,
} from "@/types/checkout-pages";
import { defaultFormAppearance } from "@/types/forms";
import type { Product } from "@/types/products";

/**
 * Create (or reuse) a published checkout page for a product, so a funnel can
 * sell in one click. The funnel never owns payment: it gets a real checkout
 * page that shows up in the Checkout list and can be edited there. One money
 * path. Idempotent per owner + product, so saves don't pile up duplicates.
 */
export async function ensureCheckoutPageForProduct(input: {
  agencyId: string;
  subAccountId: string;
  createdByUid: string;
  productId: string;
  /** Opaque owner tag, e.g. `funnel:<funnelId>`. */
  ownerKey: string;
  /** Seeds the page name and slug. */
  label: string;
}): Promise<string> {
  const db = getAdminDb();

  const productSnap = await db.doc(`products/${input.productId}`).get();
  if (!productSnap.exists) {
    throw new CheckoutPageError("That product no longer exists.");
  }
  const product = productSnap.data() as Product;
  if (product.subAccountId !== input.subAccountId) {
    throw new CheckoutPageError("That product no longer exists.");
  }
  if (!product.active) {
    throw new CheckoutPageError(
      "That product is archived. Restore it, or pick another.",
    );
  }
  if (product.unitPriceCents <= 0) {
    throw new CheckoutPageError(
      `"${product.name}" has no price. Set one before selling it.`,
    );
  }

  const col = db.collection(`subAccounts/${input.subAccountId}/checkoutPages`);

  // Equality-only query, no index needed.
  const existing = await col
    .where("createdForKey", "==", input.ownerKey)
    .limit(1)
    .get();
  if (!existing.empty) {
    const doc = existing.docs[0];
    // Re-point and re-publish in case the product changed or someone unpublished it.
    await doc.ref.set(
      {
        productId: input.productId,
        status: "published",
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    return doc.id;
  }

  // Append a counter on slug clash rather than failing.
  const base = slugifyCheckoutSlug(input.label || product.name) || "offer";
  let slug = base;
  for (let i = 2; i <= 20; i++) {
    const clash = isReservedCheckoutSlug(slug)
      ? null
      : await col.where("slug", "==", slug).limit(1).get();
    if (clash?.empty) break;
    slug = `${base}-${i}`.slice(0, 60);
  }

  const ref = col.doc();
  await ref.set({
    agencyId: input.agencyId,
    subAccountId: input.subAccountId,
    createdByUid: input.createdByUid,
    slug,
    name: input.label || product.name,
    // Published straight away: a draft would silently break the funnel's buy button.
    status: "published",
    productId: input.productId,
    bumpProductIds: [],
    headline: product.name,
    subheadline: product.description ?? "",
    collectFields: [],
    autoTags: [],
    pipelineStageId: null,
    successUrl: null,
    appearance: defaultFormAppearance(),
    /** Makes the call idempotent and tells the operator where the page came from. */
    createdForKey: input.ownerKey,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  return ref.id;
}
