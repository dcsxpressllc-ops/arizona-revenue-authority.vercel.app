import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import {
  BillingError,
  createChargeCheckoutSession,
} from "@/lib/server/billing-service";

/** In-app payment of one of this workspace's pending usage charges. */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string; chargeId: string }> },
) {
  const { id: subAccountId, chargeId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const snap = await getAdminDb().doc(`billingCharges/${chargeId}`).get();
  const charge = snap.data();
  if (!snap.exists || charge?.subAccountId !== subAccountId || charge?.kind !== "usage") {
    return NextResponse.json({ error: "Charge not found." }, { status: 404 });
  }
  if (charge.status !== "pending") {
    return NextResponse.json(
      { error: charge.status === "paid" ? "This charge is already paid." : "This charge was waived." },
      { status: 409 },
    );
  }

  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (!base) {
    return NextResponse.json({ error: "NEXT_PUBLIC_APP_URL isn't configured." }, { status: 500 });
  }
  const returnUrl = `${base}/sa/${subAccountId}/dashboard/settings?tab=billing`;

  try {
    const { url } = await createChargeCheckoutSession({
      chargeId,
      successUrl: returnUrl,
      cancelUrl: returnUrl,
    });
    return NextResponse.json({ url });
  } catch (err) {
    if (err instanceof BillingError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[usage-charges/checkout] failed", err);
    return NextResponse.json({ error: "Failed to start checkout." }, { status: 500 });
  }
}
