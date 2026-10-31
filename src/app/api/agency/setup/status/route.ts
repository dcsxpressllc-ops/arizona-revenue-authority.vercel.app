import "server-only";

import { NextResponse } from "next/server";
import { requireAgencyOwner } from "@/lib/auth/require-agency-owner";
import { readFormEnabled } from "@/lib/setup/guard";
import { GROUPS, isPresent, isWritableKey, validateVar } from "@/lib/setup/catalog";
import { vercelConfigured, listEnvKeys } from "@/lib/vercel/client";
import {
  cloudVercelProxyActive,
  isCloudManagedKey,
} from "@/lib/cloud-instance/vercel-proxy";
import { isLocalDev } from "@/lib/setup/env-file";
import { LANDING_VARIANT } from "@/config/landing";

/**
 * Status board for the setup form, merging live (process.env) with stored
 * (Vercel env list, names only via decrypt: false). Never returns values.
 *
 *   missing  neither stored nor live
 *   pending  stored in Vercel, needs a redeploy
 *   active   live in the running build (then shape-validated)
 */

type KeyState = "missing" | "pending" | "active";

export async function GET(request: Request) {
  const auth = await requireAgencyOwner(request);
  if (auth instanceof NextResponse) return auth;

  // Available when the Vercel path is on, or locally (.env.local needs no toggle).
  if (!isLocalDev() && !(await readFormEnabled())) {
    return NextResponse.json(
      { error: "The setup form is disabled." },
      { status: 403 },
    );
  }

  // If Vercel is unreachable, infer stored from live so the board still renders.
  let stored: Set<string> | null = null;
  let vercelError: string | null = null;
  if (vercelConfigured()) {
    try {
      const keys = await listEnvKeys();
      stored = new Set(keys.keys());
    } catch (e) {
      vercelError = (e as Error).message;
    }
  }

  const evalKey = (name: string, level: string) => {
    const raw = process.env[name];
    const live = isPresent(raw);
    const isStored = stored ? stored.has(name) : live;
    const state: KeyState = live ? "active" : isStored ? "pending" : "missing";
    // Can only validate the value we actually hold (the live one).
    const valid = live ? validateVar(name, (raw ?? "").trim()) === null : null;
    // On Cloud-hosted instances provisioner-owned keys are read-only; the
    // control plane rejects writes to them anyway.
    return { name, level, state, valid, managed: isCloudManagedKey(name) };
  };

  const groups = GROUPS.filter((g) => g.tier !== "preflight")
    // Variant-scoped groups only show on their own deployment.
    .filter((g) => !g.variant || g.variant === LANDING_VARIANT)
    .map((g) => ({
      title: g.title,
      tier: g.tier,
      off: g.off ?? null,
      keys: g.vars
        .filter((v) => isWritableKey(v[0]))
        .map(([name, level]) => evalKey(name, level)),
    }));

  // VERCEL_* preflight: presence only, never writable, values never returned.
  // Cloud-hosted instances write through the control plane, so an empty list
  // hides the section instead of four "Not set" rows.
  const preflight = cloudVercelProxyActive()
    ? []
    : GROUPS.filter((g) => g.tier === "preflight").flatMap((g) =>
        g.vars.map(([name, level]) => evalKey(name, level)),
      );

  return NextResponse.json({
    ok: true,
    // false: Vercel list unreadable, pending states are approximate
    storedKnown: stored !== null,
    vercelError,
    groups,
    preflight,
  });
}
