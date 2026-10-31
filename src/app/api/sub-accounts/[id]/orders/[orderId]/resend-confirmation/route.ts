import { NextResponse } from "next/server";

import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { getAdminDb } from "@/lib/firebase/admin";
import { orderDelivers } from "@/lib/server/entitlements-service";
import { sendOrderConfirmation } from "@/lib/server/order-confirmation-service";
import type { Order } from "@/types/orders";

export const dynamic = "force-dynamic";

/** POST: staff "Re-send confirmation" for a paid buy-link or checkout-page order. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; orderId: string }> },
) {
  const { id: subAccountId, orderId } = await params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const snap = await getAdminDb().doc(`orders/${orderId}`).get();
  const order = snap.exists ? ({ id: snap.id, ...snap.data() } as Order) : null;
  if (!order || order.subAccountId !== subAccountId) {
    return NextResponse.json({ error: "Order not found." }, { status: 404 });
  }
  if (!orderDelivers(order)) {
    return NextResponse.json(
      { error: "This kind of order sends its own email." },
      { status: 400 },
    );
  }
  if (order.status !== "paid" && order.status !== "partially_refunded") {
    return NextResponse.json(
      { error: "Only paid orders get a confirmation." },
      { status: 409 },
    );
  }

  const result = await sendOrderConfirmation(order);
  if (!result.ok) {
    return NextResponse.json({ error: result.error ?? "Couldn't send it." }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}
