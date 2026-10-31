import "server-only";

import { NextResponse } from "next/server";
import { requireAgencyOwner } from "@/lib/auth/require-agency-owner";
import { KNOWN_KEYS, isPresent, isWritableKey } from "@/lib/setup/catalog";
import {
  isLocalDev,
  readEnvLocalLines,
  formatEnvLine,
} from "@/lib/setup/env-file";

/**
 * Returns stored env values UNMASKED as paste-ready .env lines, so a local
 * owner can copy .env.local into Vercel.
 *
 * The only setup route that returns real secrets: owner only AND
 * isLocalDev() (VERCEL !== "1"), so it 403s on every hosted instance. Locally
 * the owner can read .env.local anyway. Only catalog keys are returned (no
 * PATH etc.), and lines are kept verbatim so the \n-escaped private key
 * survives the trip.
 */
export async function GET(request: Request) {
  const auth = await requireAgencyOwner(request);
  if (auth instanceof NextResponse) return auth;

  if (!isLocalDev()) {
    return NextResponse.json(
      { error: "Only available when running locally." },
      { status: 403 },
    );
  }

  const fileLines = readEnvLocalLines();
  // `line` is the verbatim .env line; `value` is unquoted, for hover-reveal.
  const stored: { key: string; line: string; value: string }[] = [];

  // Catalog order keeps it grouped. Prefer the raw .env.local line, else
  // format from process.env (e.g. set via the shell).
  for (const key of KNOWN_KEYS) {
    // Never surface the VERCEL_* preflight creds, VERCEL_TOKEN especially.
    if (!isWritableKey(key)) continue;
    const fromFile = fileLines.get(key);
    if (fromFile) {
      if (isPresent(fromFile.value))
        stored.push({ key, line: fromFile.line, value: fromFile.value });
      continue;
    }
    const fromEnv = process.env[key];
    if (isPresent(fromEnv)) {
      const value = (fromEnv ?? "").trim();
      stored.push({ key, line: formatEnvLine(key, value), value });
    }
  }

  return NextResponse.json({ ok: true, stored });
}
