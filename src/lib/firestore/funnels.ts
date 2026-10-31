import {
  collection,
  onSnapshot,
  query,
  type Unsubscribe,
} from "firebase/firestore";
import { getFirebaseDb } from "@/lib/firebase/client";
import type { Funnel } from "@/types/funnels";

/**
 * Read-only client subscription to a sub-account's funnels. Writes go through
 * /api/sub-accounts/[id]/funnels/* so slug and video-host checks can't be
 * bypassed. The subcollection path is the tenancy boundary.
 */
export function subscribeToFunnels(
  subAccountId: string,
  callback: (funnels: Funnel[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  const q = query(
    collection(getFirebaseDb(), `subAccounts/${subAccountId}/funnels`),
  );
  return onSnapshot(
    q,
    (snap) => {
      const funnels = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<Funnel, "id">),
      }));
      funnels.sort((a, b) => a.name.localeCompare(b.name));
      callback(funnels);
    },
    (err) => onError?.(err),
  );
}
