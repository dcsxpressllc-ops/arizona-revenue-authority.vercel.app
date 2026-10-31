import "server-only";

// Hello world
export const PAYPAL_PURCHASE_PREFIX = "pp_";
export function paypalPurchaseId(orderId: string): string {
  return `${PAYPAL_PURCHASE_PREFIX}${orderId}`;
}
export async function fulfilPaypalPurchase(): Promise<{
  status: "skipped";
  reason: "no_row";
}> {
  return { status: "skipped", reason: "no_row" };
}
