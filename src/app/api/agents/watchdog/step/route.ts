import "server-only";

import { NextResponse } from "next/server";
import { verifyQStashSignature } from "@/lib/automations/qstash";
import { runAgentSweeps } from "@/lib/server/agents-watchdog-service";

/**
 * Hourly agent monitors sweep (inbox watchdog + stale deals). QStash cron
 * `0 * * * *`, registered on cold start by lib/qstash/register-schedules.ts.
 * The path keeps its original name so existing schedules need no change. In
 * middleware PUBLIC_PATHS; the QStash signature is the auth. Per-agent guards
 * mean one failing agent only marks its own run doc, not the whole sweep.
 */
export async function POST(request: Request) {
  const signature = request.headers.get("upstash-signature");
  const rawBody = await request.text();
  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 401 });
  }
  const valid = await verifyQStashSignature(signature, rawBody);
  if (!valid) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const startedAt = Date.now();
  try {
    const { agents, results } = await runAgentSweeps();
    return NextResponse.json({
      ok: true,
      durationMs: Date.now() - startedAt,
      agents,
      results,
    });
  } catch (err) {
    console.error("[agents/watchdog] sweep failed", err);
    return NextResponse.json(
      {
        error: "sweep_failed",
        message: err instanceof Error ? err.message : "unknown",
      },
      { status: 500 },
    );
  }
}
