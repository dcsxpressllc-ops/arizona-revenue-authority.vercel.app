import {
  collection,
  onSnapshot,
  query,
  where,
  type Unsubscribe,
} from "firebase/firestore";
import { getFirebaseDb } from "@/lib/firebase/client";
import type { Order } from "@/types/orders";

/**
 * Read-only subscription to a sub-account's orders. Rules deny all client
 * writes; mutations go through lib/server/orders-service.ts because an
 * order's status reflects money Stripe confirmed, not something a browser may
 * assert. Single equality filter (no composite index) with in-memory sorting,
 * so most tenants never need a `createdAt` index.
 */
export function subscribeToOrders(
  subAccountId: string,
  callback: (orders: Order[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  const q = query(
    collection(getFirebaseDb(), "orders"),
    where("subAccountId", "==", subAccountId),
  );
  return onSnapshot(
    q,
    (snap) => {
      const orders = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<Order, "id">),
      }));
      callback(orders);
    },
    (err) => onError?.(err),
  );
}
