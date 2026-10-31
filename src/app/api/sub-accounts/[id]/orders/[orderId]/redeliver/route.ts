import { NextResponse } from "next/server";

import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { getAdminDb } from "@/lib/firebase/admin";
import { grantForOrder, orderDelivers } from "@/lib/server/entitlements-service";
import type { Order } from "@/types/orders";

export const dynamic = "force-dynamic";

/**
 * POST: staff "Re-send delivery". Re-runs every delivery on a paid order.
 * Community grants are idempotent, so this only re-sends the emails and
 * retries anything that failed. Revoked (refunded) deliveries are skipped.
 */
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
  if (!orderDelivers(order) || !order.deliveries?.length) {
    return NextResponse.json({ error: "This order has nothing to deliver." }, { status: 400 });
  }
  if (order.status !== "paid" && order.status !== "partially_refunded") {
    return NextResponse.json(
      { error: "Only paid orders can be delivered." },
      { status: 409 },
    );
  }

  try {
    const result = await grantForOrder(order, { resend: true });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error(`[orders/redeliver] failed order=${orderId}`, err);
    return NextResponse.json({ error: "Couldn't re-send the delivery." }, { status: 500 });
  }
}
