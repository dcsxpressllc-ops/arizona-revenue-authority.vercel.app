import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { GLOBAL_TERRITORY_ID } from "@/types";

interface SubAccountAccessLike {
  uid: string;
  subAccountId: string;
  subAccountRole: "admin" | "collaborator" | "agencyOwner";
}

export interface EffectiveTerritoryScope {
  /** Only for collaborators in a sub-account with territory scoping on. Admins and agency owners are never scoped. */
  enforce: boolean;
  /** Set only when `enforce` is true. */
  ids: string[] | null;
}

/**
 * Server-side twin of the client `useEffectiveTerritoryFilter` hook. Costs a
 * sub-account read plus a member read, both skipped for agency owners or when
 * scoping is off.
 */
export async function loadEffectiveTerritoryScope(
  access: SubAccountAccessLike,
): Promise<EffectiveTerritoryScope> {
  if (
    access.subAccountRole === "admin" ||
    access.subAccountRole === "agencyOwner"
  ) {
    return { enforce: false, ids: null };
  }
  const db = getAdminDb();
  const subSnap = await db.doc(`subAccounts/${access.subAccountId}`).get();
  const enabled = subSnap.data()?.territoryScopingEnabled === true;
  if (!enabled) return { enforce: false, ids: null };

  const memberSnap = await db
    .doc(
      `subAccounts/${access.subAccountId}/subAccountMembers/${access.uid}`,
    )
    .get();
  const assigned =
    (memberSnap.data()?.assignedTerritoryIds as string[] | undefined) ??
    [];
  // "global" is the shared pool every collaborator sees, matching the rules'
  // `territoryId == "global"` clause and the client hook's withGlobal().
  const ids = [
    GLOBAL_TERRITORY_ID,
    ...assigned.filter((id) => id !== GLOBAL_TERRITORY_ID),
  ];
  return { enforce: true, ids };
}

function denied(): NextResponse {
  return NextResponse.json(
    { error: "This record isn't in one of your assigned territories." },
    { status: 403 },
  );
}

/**
 * 403 when a scoped collaborator touches a territory that isn't theirs, else null.
 *
 *   const gate = await territoryGate(access, contact.territoryId);
 *   if (gate) return gate;
 */
export async function territoryGate(
  access: SubAccountAccessLike,
  territoryId: string | null | undefined,
): Promise<NextResponse | null> {
  const scope = await loadEffectiveTerritoryScope(access);
  if (!scope.enforce) return null;
  if (!territoryId || !(scope.ids ?? []).includes(territoryId)) {
    return denied();
  }
  return null;
}

/**
 * territoryGate for when you only have a contactId (e.g. quote routes). Mirrors
 * the `canReadInheritedFromContact` rule for tasks/quotes/events.
 */
export async function territoryGateForContact(
  access: SubAccountAccessLike,
  contactId: string | null | undefined,
): Promise<NextResponse | null> {
  const scope = await loadEffectiveTerritoryScope(access);
  if (!scope.enforce) return null;
  if (!contactId) return denied();
  const snap = await getAdminDb().doc(`contacts/${contactId}`).get();
  const territoryId =
    (snap.data()?.territoryId as string | null | undefined) ?? null;
  if (!territoryId || !(scope.ids ?? []).includes(territoryId)) {
    return denied();
  }
  return null;
}
