import "server-only";

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Writes `.env.local` for the setup form's "update both" mode. Local dev only;
 * on Vercel the filesystem is read-only, so isLocalDev() hides the option.
 * Assumes single-line values; anything with whitespace, quotes, `#` or `=` is
 * double-quoted so dotenv reads it back intact.
 */

const ENV_LOCAL_PATH = resolve(process.cwd(), ".env.local");

/** Vercel sets VERCEL="1" at build and runtime; unset locally. */
export function isLocalDev(): boolean {
  return process.env.VERCEL !== "1";
}

function needsQuoting(value: string): boolean {
  return /[\s#"'=]/.test(value) || value === "";
}

export function formatEnvLine(key: string, value: string): string {
  if (!needsQuoting(value)) return `${key}=${value}`;
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `${key}="${escaped}"`;
}

/** Tolerates an `export ` prefix. */
function lineMatcher(key: string): RegExp {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*(?:export\\s+)?${esc}\\s*=`);
}

export interface EnvFileResult {
  key: string;
  ok: boolean;
  action?: "created" | "updated";
  error?: string;
}

/**
 * Merge vars into `.env.local`: update in place, append new ones, leave every
 * other line alone. One write. Returns a per-key result.
 */
export function writeEnvLocalVars(
  vars: { key: string; value: string }[],
): EnvFileResult[] {
  const results: EnvFileResult[] = [];
  let text = "";
  try {
    if (existsSync(ENV_LOCAL_PATH)) text = readFileSync(ENV_LOCAL_PATH, "utf8");
  } catch (e) {
    // Can't read it: fail every key rather than clobber the file.
    return vars.map((v) => ({
      key: v.key,
      ok: false,
      error: `Couldn't read .env.local: ${(e as Error).message}`,
    }));
  }

  const lines = text.split(/\r?\n/);
  for (const { key, value } of vars) {
    const formatted = formatEnvLine(key, value);
    const idx = lines.findIndex((l) => lineMatcher(key).test(l));
    if (idx >= 0) {
      lines[idx] = formatted;
      results.push({ key, ok: true, action: "updated" });
    } else {
      // Drop one trailing blank so appends don't pile up gaps.
      while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
        lines.pop();
      }
      lines.push(formatted);
      results.push({ key, ok: true, action: "created" });
    }
  }

  try {
    writeFileSync(ENV_LOCAL_PATH, lines.join("\n") + "\n", "utf8");
  } catch (e) {
    // Write failed, so the whole batch is suspect.
    return vars.map((v) => ({
      key: v.key,
      ok: false,
      error: `Couldn't write .env.local: ${(e as Error).message}`,
    }));
  }

  return results;
}

export interface StoredEnvLine {
  /** `KEY=<rhs>` with the RHS verbatim (quotes/escapes kept). */
  line: string;
  /** Best-effort unquoted value, for presence checks only. */
  value: string;
}

/**
 * Raw assignment lines per key, RHS verbatim. That matters for
 * FIREBASE_ADMIN_PRIVATE_KEY, whose quoted `\n`-escaped form must round-trip.
 * Empty map if the file is missing or unreadable.
 */
export function readEnvLocalLines(): Map<string, StoredEnvLine> {
  const map = new Map<string, StoredEnvLine>();
  try {
    if (!existsSync(ENV_LOCAL_PATH)) return map;
    const text = readFileSync(ENV_LOCAL_PATH, "utf8");
    for (const rawLine of text.split(/\r?\n/)) {
      const m = rawLine.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
      if (!m) continue;
      const key = m[1];
      const rhs = m[2].trimEnd();
      let value = rhs;
      if (
        (rhs.startsWith('"') && rhs.endsWith('"') && rhs.length >= 2) ||
        (rhs.startsWith("'") && rhs.endsWith("'") && rhs.length >= 2)
      ) {
        value = rhs.slice(1, -1);
      }
      // Last one wins, like dotenv.
      map.set(key, { line: `${key}=${rhs}`, value });
    }
  } catch {
  }
  return map;
}
