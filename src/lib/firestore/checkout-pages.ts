import {
  collection,
  onSnapshot,
  query,
  type Unsubscribe,
} from "firebase/firestore";
import { getFirebaseDb } from "@/lib/firebase/client";
import type { CheckoutPage } from "@/types/checkout-pages";

/**
 * Read-only client subscription to a sub-account's checkout pages. Writes go
 * through /api/sub-accounts/[id]/checkout-pages/* so validation can't be
 * bypassed. The subcollection path is the tenancy boundary, so no `where`.
 */
export function subscribeToCheckoutPages(
  subAccountId: string,
  callback: (pages: CheckoutPage[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  const q = query(
    collection(getFirebaseDb(), `subAccounts/${subAccountId}/checkoutPages`),
  );
  return onSnapshot(
    q,
    (snap) => {
      const pages = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<CheckoutPage, "id">),
      }));
      pages.sort((a, b) => a.name.localeCompare(b.name));
      callback(pages);
    },
    (err) => onError?.(err),
  );
}
