// Typed view over env-schema.mjs, which stays the source of truth because the
// `pnpm doctor` CLI runs it under bare node.

import {
  GROUPS as RAW_GROUPS,
  KNOWN_KEYS as RAW_KNOWN_KEYS,
  NON_WRITABLE_KEYS as RAW_NON_WRITABLE_KEYS,
  validateVar as rawValidateVar,
  isPresent as rawIsPresent,
  evaluateGroup as rawEvaluateGroup,
} from "./env-schema.mjs";

export type VarLevel = "req" | "rec" | "opt";
export type GroupTier = "boot" | "feature" | "preflight";

/** [name, level, optional shape validator]. */
export type VarTuple = [string, VarLevel, ((v: string) => string | null)?];

export interface EnvGroup {
  title: string;
  tier: GroupTier;
  off?: string;
  independent?: boolean;
  /** Only shown on this landing variant (e.g. "leadstack"); undefined = everywhere.
   *  Consumers that know the active variant do the filtering. */
  variant?: string;
  vars: VarTuple[];
  deep?: (
    add: (level: string, msg: string) => void,
    env: { has: (k: string) => boolean; val: (k: string) => string },
  ) => void;
}

export const GROUPS = RAW_GROUPS as unknown as EnvGroup[];
export const KNOWN_KEYS = RAW_KNOWN_KEYS as unknown as string[];
export const NON_WRITABLE_KEYS = RAW_NON_WRITABLE_KEYS as unknown as Set<string>;

/** Warning when the value looks malformed, else null. */
export function validateVar(name: string, value: string): string | null {
  return rawValidateVar(name, value) as string | null;
}

/** Present, non-blank and not a placeholder. */
export function isPresent(value: string | undefined): boolean {
  return rawIsPresent(value) as boolean;
}

/** Preflight prerequisites can't be written via the setup form. */
export function isWritableKey(name: string): boolean {
  return KNOWN_KEYS.includes(name) && !NON_WRITABLE_KEYS.has(name);
}

export type GroupStatus = "ok" | "check" | "off" | "error";

export interface GroupEvaluation {
  status: GroupStatus;
  notes: { level: string; msg: string }[];
  missingReq: string[];
  missingRec: string[];
  reqPresent: number;
  reqTotal: number;
}

/** Same implementation `pnpm doctor` uses, so both agree on the status. */
export function evaluateGroup(
  group: EnvGroup,
  getValue: (name: string) => string | undefined,
): GroupEvaluation {
  return rawEvaluateGroup(group, getValue) as GroupEvaluation;
}

/** Variant a key is scoped to, or null if shown everywhere. Compare with LANDING_VARIANT. */
export function keyVariant(name: string): string | null {
  for (const g of GROUPS) {
    if (g.vars.some((v) => v[0] === name)) return g.variant ?? null;
  }
  return null;
}
