import "server-only";

import { NextResponse } from "next/server";
import { requireAgencyOwner } from "@/lib/auth/require-agency-owner";
import { readFormEnabled } from "@/lib/setup/guard";
import { isWritableKey, keyVariant, validateVar } from "@/lib/setup/catalog";
import { vercelConfigured, upsertEnvVars } from "@/lib/vercel/client";
import { isLocalDev, writeEnvLocalVars } from "@/lib/setup/env-file";
import { LANDING_VARIANT } from "@/config/landing";

/**
 * Writes env vars to Vercel and/or the local .env.local.
 * Body: { vars: [{ key, value }], targets: { vercel?, local? } }
 *
 * Gating follows blast radius: always agency owner; local also needs
 * isLocalDev(); Vercel also needs formEnabled and vercelConfigured(). Only
 * writable catalog keys are accepted (never the VERCEL_* preflight keys, to
 * avoid an escalation loop). One bad value rejects the whole batch (422).
 * Values are never logged. No redeploy here; call /redeploy after.
 */

interface Body {
  vars?: { key?: unknown; value?: unknown }[];
  targets?: { vercel?: unknown; local?: unknown };
}

export async function POST(request: Request) {
  const auth = await requireAgencyOwner(request);
  if (auth instanceof NextResponse) return auth;

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!Array.isArray(body.vars) || body.vars.length === 0) {
    return NextResponse.json(
      { error: "`vars` must be a non-empty array." },
      { status: 400 },
    );
  }

  // Collect every problem rather than stopping at the first.
  const clean: { key: string; value: string }[] = [];
  const rejected: { key: string; reason: string }[] = [];

  for (const entry of body.vars) {
    const key = typeof entry.key === "string" ? entry.key.trim() : "";
    const value = typeof entry.value === "string" ? entry.value : "";
    if (!key) {
      rejected.push({ key: "(blank)", reason: "missing key name" });
      continue;
    }
    if (!isWritableKey(key)) {
      rejected.push({ key, reason: "not a writable setup key" });
      continue;
    }
    // Variant-scoped keys (e.g. the founders offset) aren't surfaced on other
    // variants, so writing one there would be a silent no-op.
    const variant = keyVariant(key);
    if (variant && variant !== LANDING_VARIANT) {
      rejected.push({ key, reason: "not available on this deployment" });
      continue;
    }
    if (value.trim() === "") {
      rejected.push({ key, reason: "empty value" });
      continue;
    }
    const shape = validateVar(key, value.trim());
    if (shape) {
      rejected.push({ key, reason: shape });
      continue;
    }
    clean.push({ key, value });
  }

  if (rejected.length > 0) {
    return NextResponse.json(
      { error: "Some values were rejected — nothing was written.", rejected },
      { status: 422 },
    );
  }

  // Default to Vercel; local is only honored in dev.
  const wantVercel = body.targets?.vercel !== false; // default true
  const wantLocal = body.targets?.local === true && isLocalDev();

  if (body.targets?.local === true && !isLocalDev()) {
    return NextResponse.json(
      { error: "The .env.local target is only available when running locally." },
      { status: 400 },
    );
  }
  if (!wantVercel && !wantLocal) {
    return NextResponse.json(
      { error: "Select at least one write target." },
      { status: 400 },
    );
  }

  const out: {
    vercel?: { key: string; ok: boolean; action?: string; error?: string }[];
    local?: { key: string; ok: boolean; action?: string; error?: string }[];
  } = {};

  if (wantVercel) {
    // Only the Vercel path needs the shared toggle.
    if (!(await readFormEnabled())) {
      return NextResponse.json(
        {
          error:
            "Vercel writes are disabled. Enable the setup form in Agency → Guided setup first.",
        },
        { status: 403 },
      );
    }
    if (!vercelConfigured()) {
      return NextResponse.json(
        { error: "Vercel is not configured on this deployment." },
        { status: 503 },
      );
    }
    try {
      out.vercel = await upsertEnvVars(clean);
    } catch (e) {
      console.error("[agency/setup/env] vercel upsert failed", (e as Error).message);
      return NextResponse.json(
        { error: `Vercel write failed: ${(e as Error).message}` },
        { status: 502 },
      );
    }
  }

  if (wantLocal) {
    out.local = writeEnvLocalVars(clean);
  }

  const anyFailed =
    (out.vercel?.some((r) => !r.ok) ?? false) ||
    (out.local?.some((r) => !r.ok) ?? false);

  // key names only, never values
  console.info(
    "[agency/setup/env] wrote",
    clean.map((v) => v.key).join(", "),
    JSON.stringify({ vercel: wantVercel, local: wantLocal }),
  );

  return NextResponse.json(
    {
      ok: !anyFailed,
      // Vercel writes need a redeploy, local writes a dev-server restart.
      needsRedeploy: wantVercel,
      results: out,
    },
    { status: anyFailed ? 207 : 200 },
  );
}
