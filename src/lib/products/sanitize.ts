import type { Product } from "@/types/products";

/** Product payload sanitizer for create and update. In lib/ because Next 15 forbids extra exports from route files. */

export interface CreateProductPayload {
  name?: string;
  description?: string;
  unitPriceCents?: number;
  currency?: string;
  active?: boolean;
  bumpEligible?: boolean;
  bumpHeadline?: string;
}

export function sanitizeProductPayload(
  body: CreateProductPayload,
): Partial<Product> {
  const out: Partial<Product> = {};

  if (typeof body.name === "string") {
    out.name = body.name.trim().slice(0, 200);
  }
  if (typeof body.description === "string") {
    out.description = body.description.trim().slice(0, 2_000);
  }
  if (
    typeof body.unitPriceCents === "number" &&
    Number.isFinite(body.unitPriceCents)
  ) {
    out.unitPriceCents = Math.max(0, Math.round(body.unitPriceCents));
  }
  if (typeof body.currency === "string" && body.currency.trim()) {
    out.currency = body.currency.trim().toUpperCase().slice(0, 3);
  }
  if (typeof body.active === "boolean") {
    out.active = body.active;
  }
  if (typeof body.bumpEligible === "boolean") {
    out.bumpEligible = body.bumpEligible;
  }
  if (typeof body.bumpHeadline === "string") {
    // Anything longer belongs in the product description, which checkout falls back to.
    out.bumpHeadline = body.bumpHeadline.trim().slice(0, 140);
  }

  return out;
}
