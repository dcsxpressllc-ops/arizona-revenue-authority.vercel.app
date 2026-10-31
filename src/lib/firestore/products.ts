import {
  collection,
  onSnapshot,
  query,
  where,
  type Unsubscribe,
} from "firebase/firestore";
import { getFirebaseDb } from "@/lib/firebase/client";
import type { Product } from "@/types/products";
import type { TenantScope } from "@/types";

/** Read-only client subscriptions to `products`; writes go through /api/sub-accounts/[id]/products/... */

const PRODUCTS = "products";

export function subscribeToProducts(
  scope: TenantScope,
  callback: (products: Product[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  const q = query(
    collection(getFirebaseDb(), PRODUCTS),
    where("subAccountId", "==", scope.subAccountId),
  );
  return onSnapshot(
    q,
    (snap) => {
      const products = snap.docs.map(
        (d) => ({ id: d.id, ...(d.data() as Omit<Product, "id">) }),
      );
      // Active first, then archived; alphabetical within each.
      products.sort((a, b) => {
        if (a.active !== b.active) return a.active ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      callback(products);
    },
    onError,
  );
}
