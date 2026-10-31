import { NextResponse } from "next/server";

import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import {
  ProductImageGenError,
  requestProductImageGeneration,
} from "@/lib/server/product-images-service";

export const dynamic = "force-dynamic";

/** POST: the "Generate image" button. Same access as editing the product. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; productId: string }> },
) {
  const { id: subAccountId, productId } = await params;
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  try {
    await requestProductImageGeneration({ subAccountId, productId });
    return NextResponse.json({ ok: true }, { status: 202 });
  } catch (err) {
    if (err instanceof ProductImageGenError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[products/images/generate] failed", err);
    return NextResponse.json({ error: "Couldn't start the image." }, { status: 500 });
  }
}
