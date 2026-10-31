import type { Timestamp, FieldValue } from "firebase/firestore";

/**
 * Per sub-account product catalog for quotes and invoices. Prices are integer
 * cents here, but line items use whole units, so they're converted on add.
 * Name, description and price are copied onto the line item, so later edits
 * never touch old quotes.
 */

export interface Product {
  id: string;

  agencyId: string;
  subAccountId: string;
  createdByUid: string;

  name: string;
  description: string;
  unitPriceCents: number;
  /** ISO 4217. Defaults to "USD". */
  currency: string;
  /** false = archived (soft delete). Hidden from the picker only. */
  active: boolean;

  // Order bump fields are optional so older docs stay valid; absent = false.
  /** Can be offered as a one-click add-on on a checkout page. */
  bumpEligible?: boolean;
  /** One-liner beside the bump checkbox. Falls back to description. */
  bumpHeadline?: string;

  // Sell online fields are optional too; absent = catalog-only, as before.
  /** Shown on the website and the express buy link. */
  sellOnline?: boolean;
  /** Unique per sub-account, lowercase kebab. Minted on first sellOnline. */
  slug?: string;
  /** Max MAX_PRODUCT_IMAGES; first is the primary. Written by server routes only. */
  images?: ProductImage[];
  /** Longer public sales copy for the product page. Falls back to description. */
  publicDescription?: string;
  /** Website Buy buttons go to this published checkout page instead of express. */
  checkoutPageId?: string | null;
  /** What the buyer gets once paid. Absent = { type: "none" }. */
  delivery?: ProductDelivery;
  /** Bumped on public-facing edits so resyncs can skip no-ops. */
  publicVersion?: number;
  /** Set while an AI image is being generated, or after it failed. */
  imageGeneration?: ProductImageGeneration | null;
  /** Tries today, for the per-product daily cap. */
  imageGenerationDay?: { day: string; n: number } | null;

  createdAt: Timestamp | FieldValue | null;
  updatedAt: Timestamp | FieldValue | null;
}

export interface ProductImage {
  id: string;
  /** Download URL in our own Storage bucket, never a third-party hotlink. */
  url: string;
  /** Storage object path, so delete can remove the file. */
  path: string;
  source: "upload" | "generated";
  alt: string;
  width?: number | null;
  height?: number | null;
  createdAt: number;
}

export type ProductDelivery =
  | { type: "none" }
  | { type: "community"; communityGroupId: string; courseId?: string | null }
  | { type: "download"; url: string; label?: string };

export interface ProductImageGeneration {
  jobId: string;
  status: "pending" | "failed";
  error?: string | null;
  /** Epoch ms. */
  requestedAt: number;
}

export const MAX_PRODUCT_IMAGES = 6;

export const DEFAULT_PRODUCT: Omit<
  Product,
  "id" | "agencyId" | "subAccountId" | "createdByUid" | "createdAt" | "updatedAt"
> = {
  name: "",
  description: "",
  unitPriceCents: 0,
  currency: "USD",
  active: true,
};
