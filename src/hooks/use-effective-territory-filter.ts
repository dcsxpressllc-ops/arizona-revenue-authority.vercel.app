"use client";

import { useEffect, useMemo, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { useAuth } from "@/hooks/use-auth";
import { useOptionalSubAccount } from "@/context/sub-account-context";
import { getFirebaseDb } from "@/lib/firebase/client";
import { GLOBAL_TERRITORY_ID } from "@/types";

/**
 * Scoped collaborators always see the shared "Global" pool. Prepend it
 * (deduped, first so it survives the 30-item `in` slice) to match the rules'
 * `territoryId == "global"` clause.
 */
function withGlobal(ids: string[]): string[] {
  return [GLOBAL_TERRITORY_ID, ...ids.filter((id) => id !== GLOBAL_TERRITORY_ID)];
}

export interface EffectiveTerritoryFilter {
  /**
   * False while the membership doc loads. Callers can wait for true, or accept
   * a brief unfiltered window (fine for admins, possibly leaky for
   * collaborators until the snapshot lands).
   */
  ready: boolean;
  /**
   * null = no filter (admin, agency owner, or scoping off). Otherwise pass to
   * subscribeToDeals/subscribeToContacts; [] = no territories, which the query
   * helpers turn into an empty snapshot.
   */
  filter: string[] | null;
}

/**
 * Territory filter for subscribeToDeals/subscribeToContacts. Reacts to the
 * toggle, role changes and edits to the member's assignedTerritoryIds.
 * Unless `territoryScopingEnabled === true` it returns `{ ready: true,
 * filter: null }` immediately without subscribing.
 */
export function useEffectiveTerritoryFilter(): EffectiveTerritoryFilter {
  const { user } = useAuth();
  // Optional so callers above SubAccountProvider (e.g. Cmd+K) can use it; no
  // active sub-account means no filter.
  const ctx = useOptionalSubAccount();
  const subAccount = ctx?.subAccount ?? null;
  const subAccountId = ctx?.subAccountId ?? null;
  const myRole = ctx?.myRole ?? null;

  const scopingOn = subAccount?.territoryScopingEnabled === true;
  const isPrivileged = myRole === "admin"; // agency owners resolve to admin

  const [assignedIds, setAssignedIds] = useState<string[] | null>(null);

  useEffect(() => {
    // No subscription needed; both reset paths give a stable null filter.
    if (!scopingOn || isPrivileged || !user || !subAccountId) {
      setAssignedIds(null);
      return;
    }
    const ref = doc(
      getFirebaseDb(),
      "subAccounts",
      subAccountId,
      "subAccountMembers",
      user.uid,
    );
    const unsub = onSnapshot(
      ref,
      (snap) => {
        if (!snap.exists()) {
          setAssignedIds([]);
          return;
        }
        const ids =
          (snap.data().assignedTerritoryIds as string[] | undefined) ?? [];
        setAssignedIds(ids);
      },
      () => setAssignedIds([]),
    );
    return () => unsub();
  }, [scopingOn, isPrivileged, user, subAccountId]);

  // Stable reference: consumers put this in effect deps to (re)attach
  // Firestore listeners, so a fresh array each render would loop forever.
  const filter = useMemo(
    () => (assignedIds === null ? null : withGlobal(assignedIds)),
    [assignedIds],
  );

  if (!scopingOn || isPrivileged) {
    return { ready: true, filter: null };
  }
  // Collaborator: resolves when the member doc snapshot lands.
  if (assignedIds === null) {
    return { ready: false, filter: null };
  }
  return { ready: true, filter };
}
