"use client";

import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { useAuth } from "@/hooks/use-auth";
import { useSubAccount } from "@/context/sub-account-context";
import { getFirebaseDb } from "@/lib/firebase/client";
import { subscribeToTerritories } from "@/lib/firestore/territories";
import { Label } from "@/components/ui/label";
import { GLOBAL_TERRITORY_ID, type TerritoryDoc } from "@/types";

interface TerritorySelectFieldProps {
  /** Territory id or null. */
  value: string | null;
  onChange: (next: string | null) => void;
  /** Default "Territory". */
  label?: string;
  id?: string;
  disabled?: boolean;
  /**
   * Single-territory collaborator + null value: auto-select their territory.
   * Used by the new-deal dialog and add-contact modal.
   */
  autoDefaultFromAssigned?: boolean;
}

/**
 * Territory picker for a deal or contact. Renders nothing when scoping is off, so
 * the saved doc carries `territoryId: null`; this is the UI gate for the off-by-default
 * contract. Loads its own territories and the caller's membership doc.
 */
export function TerritorySelectField({
  value,
  onChange,
  label = "Territory",
  id = "territory-field",
  disabled,
  autoDefaultFromAssigned,
}: TerritorySelectFieldProps) {
  const { user } = useAuth();
  const { subAccountId, subAccount, myRole } = useSubAccount();
  const scopingOn = subAccount?.territoryScopingEnabled === true;

  const [territories, setTerritories] = useState<TerritoryDoc[]>([]);
  const [myAssignedIds, setMyAssignedIds] = useState<string[]>([]);

  useEffect(() => {
    if (!scopingOn || !subAccountId) {
      setTerritories([]);
      return;
    }
    const unsub = subscribeToTerritories(subAccountId, (list) =>
      setTerritories(list),
    );
    return () => unsub();
  }, [scopingOn, subAccountId]);

  useEffect(() => {
    if (!scopingOn || !subAccountId || !user) {
      setMyAssignedIds([]);
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
        const ids =
          (snap.data()?.assignedTerritoryIds as string[] | undefined) ?? [];
        setMyAssignedIds(ids);
      },
      () => setMyAssignedIds([]),
    );
    return () => unsub();
  }, [scopingOn, subAccountId, user]);

  // Single-territory collaborators default to their territory; everyone else
  // to Global. Only when value is null and the prop opts in.
  useEffect(() => {
    if (!autoDefaultFromAssigned) return;
    if (value !== null) return;
    if (myRole !== "admin" && myAssignedIds.length === 1) {
      onChange(myAssignedIds[0]);
    } else {
      onChange(GLOBAL_TERRITORY_ID);
    }
    // onChange left out on purpose so callers can pass a fresh function each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoDefaultFromAssigned, value, myRole, myAssignedIds]);

  if (!scopingOn) return null;

  // Global is the top option, so it's excluded from the list below.
  const activeTerritories = territories.filter(
    (t) => t.status === "active" && t.id !== GLOBAL_TERRITORY_ID,
  );

  // Keep the assigned territory listed even if archived since, or the form
  // looks like it lost the value.
  const currentArchived = territories.find(
    (t) => t.id === value && t.status === "archived",
  );

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        value={value ?? GLOBAL_TERRITORY_ID}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="flex h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30 [&_option]:bg-background [&_option]:text-foreground"
      >
        <option value={GLOBAL_TERRITORY_ID}>Global (all reps)</option>
        {activeTerritories.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
            {t.code ? ` (${t.code})` : ""}
          </option>
        ))}
        {currentArchived && (
          <option value={currentArchived.id}>
            {currentArchived.name} (archived)
          </option>
        )}
      </select>
    </div>
  );
}
