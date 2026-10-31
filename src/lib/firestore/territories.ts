import {
  collection,
  onSnapshot,
  query,
  where,
  type Unsubscribe,
} from "firebase/firestore";
import { getFirebaseDb } from "@/lib/firebase/client";
import type { TerritoryDoc } from "@/types";

/**
 * Client subscription for a sub-account's territories (settings, pickers,
 * pipeline filter, contacts column). Writes go through
 * /api/sub-accounts/[id]/territories/*. The redundant `subAccountId` field is
 * stamped on every write so the listener can filter on it.
 */
export function subscribeToTerritories(
  subAccountId: string,
  callback: (territories: TerritoryDoc[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  const q = query(
    collection(getFirebaseDb(), "subAccounts", subAccountId, "territories"),
    where("subAccountId", "==", subAccountId),
  );
  return onSnapshot(
    q,
    (snap) => {
      const list = snap.docs.map(
        (d) => ({ id: d.id, ...(d.data() as Omit<TerritoryDoc, "id">) }),
      );
      list.sort((a, b) => a.name.localeCompare(b.name));
      callback(list);
    },
    (err) => onError?.(err),
  );
}
