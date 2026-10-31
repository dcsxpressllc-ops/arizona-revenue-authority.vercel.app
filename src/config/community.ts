/** Community + Courses config: naming, gamification thresholds, limits. Client-safe (no secrets, no server-only). */

export const COMMUNITY = {
  name: "Community",
} as const;

/** Max length of a group's "About" copy. Enforced server and client. */
export const ABOUT_MAX_CHARS = 1000;

/** Max length of the join-card tagline. Enforced server and client. */
export const TAGLINE_MAX_CHARS = 100;

/**
 * Skool's points-to-level curve (1 like = 1 point, per group). Level is the
 * highest entry whose threshold is <= the member's points.
 */
export const LEVEL_THRESHOLDS: readonly number[] = [
  0, // Level 1
  5, // Level 2
  20, // Level 3
  65, // Level 4
  155, // Level 5
  515, // Level 6
  2015, // Level 7
  8015, // Level 8
  33015, // Level 9
] as const;

/** Points total to a 1-9 level. */
export function levelForPoints(points: number): number {
  let level = 1;
  for (let i = 0; i < LEVEL_THRESHOLDS.length; i++) {
    if (points >= LEVEL_THRESHOLDS[i]) level = i + 1;
  }
  return level;
}
