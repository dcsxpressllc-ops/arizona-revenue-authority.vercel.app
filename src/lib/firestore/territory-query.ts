import { where, type QueryConstraint } from "firebase/firestore";

/**
 * Territory filter -> query plan, so every scoped subscribe behaves the same:
 *   null   no filter (admin, owner, scoping off)
 *   []     collaborator with no territories. Don't run an unfiltered query:
 *          rules aren't filters, so it'd be rejected with permission-denied
 *          instead of returning empty. Caller short-circuits to [].
 *   ids[]  where("territoryId", "in", ids), sliced to Firestore's 30 (member
 *          assignment is capped at 30 upstream, so nothing real is dropped).
 */
export type TerritoryQueryPlan =
  | { mode: "all" }
  | { mode: "empty" }
  | { mode: "in"; constraint: QueryConstraint };

export function territoryQueryPlan(
  filter: string[] | null | undefined,
): TerritoryQueryPlan {
  if (!filter) return { mode: "all" };
  if (filter.length === 0) return { mode: "empty" };
  return {
    mode: "in",
    constraint: where("territoryId", "in", filter.slice(0, 30)),
  };
}

export const NOOP_UNSUB = () => {};
