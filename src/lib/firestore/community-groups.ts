import {
  collection,
  doc,
  onSnapshot,
  query,
  where,
  type Unsubscribe,
} from "firebase/firestore";
import { getFirebaseDb } from "@/lib/firebase/client";
import type { CommunityGroup } from "@/types/community";

/**
 * Client subscription for the dashboard groups list. Writes go through
 * /api/sub-accounts/[id]/community/* (client writes closed in rules); public
 * /c/ pages read via the Admin SDK. Single equality filter, sorted client-side.
 */
export function subscribeToCommunityGroups(
  subAccountId: string,
  callback: (groups: CommunityGroup[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  const q = query(
    collection(getFirebaseDb(), `subAccounts/${subAccountId}/communityGroups`),
    where("subAccountId", "==", subAccountId),
  );
  return onSnapshot(
    q,
    (snap) => {
      callback(
        snap.docs.map(
          (d) => ({ id: d.id, ...(d.data() as Omit<CommunityGroup, "id">) }),
        ),
      );
    },
    (err) => onError?.(err),
  );
}

/** One group's mode/branding without loading the list. */
export function subscribeToCommunityGroup(
  subAccountId: string,
  groupId: string,
  callback: (group: CommunityGroup | null) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  return onSnapshot(
    doc(
      getFirebaseDb(),
      `subAccounts/${subAccountId}/communityGroups/${groupId}`,
    ),
    (snap) => {
      callback(
        snap.exists()
          ? { id: snap.id, ...(snap.data() as Omit<CommunityGroup, "id">) }
          : null,
      );
    },
    (err) => onError?.(err),
  );
}
