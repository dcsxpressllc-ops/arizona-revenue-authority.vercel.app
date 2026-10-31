import "server-only";

import { NextResponse } from "next/server";
import { verifyQStashSignature } from "@/lib/automations/qstash";
import { runUsageClose } from "@/lib/server/usage-billing-service";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Daily month close. Runs every day, not just the 1st, so a failed run retries. */
export async function POST(request: Request) {
  const signature = request.headers.get("upstash-signature");
  const rawBody = await request.text();
  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 401 });
  }
  if (!(await verifyQStashSignature(signature, rawBody))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const startedAt = Date.now();
  try {
    const result = await runUsageClose(new Date());
    return NextResponse.json({ ok: true, durationMs: Date.now() - startedAt, ...result });
  } catch (err) {
    console.error("[cron/usage-close] run failed", err);
    return NextResponse.json(
      { error: "usage_close_failed", message: err instanceof Error ? err.message : "unknown" },
      { status: 500 },
    );
  }
}
