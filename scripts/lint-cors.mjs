#!/usr/bin/env node
/**
 * Fails the build if any `src/app/api/**​/route.ts` serves
 * `Access-Control-Allow-Origin: *` (or similar) and isn't in the allowlist below.
 *
 * Forms-ingest is open-CORS on purpose so third-party sites can post to it.
 * Everything else must reject cross-origin browser requests; a wildcard on an
 * admin route turns any XSS into a key/session leak.
 *
 * Run via `"lint:cors": "node scripts/lint-cors.mjs"`, before `pnpm build` in CI.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const PROJECT_ROOT = join(SCRIPT_DIR, "..");
const API_ROOT = join(PROJECT_ROOT, "src", "app", "api");

/**
 * POSIX paths under src/app/api allowed to send a wildcard origin. A new entry
 * needs a security note in the PR and must be write-only and scope-limited.
 */
const OPEN_CORS_ALLOWLIST = new Set([
  "forms/[id]/submit/route.ts",
  "v1/forms/[formId]/submissions/route.ts",
  // Web Chat widget: public browser API; origin is checked per sub-account
  // inside the route.
  "web-chat/config/route.ts",
  "web-chat/message/route.ts",
  "web-chat/capture/route.ts",
]);

const CORS_REGEX =
  /Access-Control-Allow-Origin[^,]*?["'`:]?\s*["'`]?\*/i;

async function* walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile() && entry.name === "route.ts") {
      yield full;
    }
  }
}

function posix(p) {
  return p.split(sep).join("/");
}

async function main() {
  const violations = [];
  for await (const file of walk(API_ROOT)) {
    const rel = posix(relative(API_ROOT, file));
    const text = await readFile(file, "utf8");
    if (CORS_REGEX.test(text)) {
      if (!OPEN_CORS_ALLOWLIST.has(rel)) {
        violations.push(rel);
      }
    }
  }

  if (violations.length === 0) {
    console.log("[lint-cors] OK — no unauthorised open-CORS surfaces.");
    process.exit(0);
  }

  console.error(
    "[lint-cors] FAIL — found Access-Control-Allow-Origin: * outside the allowlist:",
  );
  for (const v of violations) {
    console.error(`  src/app/api/${v}`);
  }
  console.error(
    "\nIf this is intentional, add the path to OPEN_CORS_ALLOWLIST in scripts/lint-cors.mjs",
  );
  console.error(
    "AND document the security review in the PR. Otherwise, remove the open-CORS header.",
  );
  process.exit(1);
}

main().catch((err) => {
  console.error("[lint-cors] script failed:", err);
  process.exit(1);
});
