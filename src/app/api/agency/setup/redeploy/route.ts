import "server-only";

import { NextResponse } from "next/server";
import { requireSetupEnabled } from "@/lib/setup/guard";
import { vercelConfigured, triggerRedeploy } from "@/lib/vercel/client";

/**
 * Fires the Vercel deploy hook. Separate from /env so callers batch writes
 * and redeploy once. requireSetupEnabled covers owner + formEnabled.
 */
export async function POST(request: Request) {
  const auth = await requireSetupEnabled(request);
  if (auth instanceof NextResponse) return auth;

  if (!vercelConfigured()) {
    return NextResponse.json(
      { error: "Vercel is not configured on this deployment." },
      { status: 503 },
    );
  }

  try {
    const result = await triggerRedeploy();
    console.info("[agency/setup/redeploy] triggered", result.id ?? "(no id)");
    return NextResponse.json({ ok: true, deploymentId: result.id ?? null });
  } catch (e) {
    console.error("[agency/setup/redeploy] failed", (e as Error).message);
    return NextResponse.json(
      { error: `Redeploy failed: ${(e as Error).message}` },
      { status: 502 },
    );
  }
}
