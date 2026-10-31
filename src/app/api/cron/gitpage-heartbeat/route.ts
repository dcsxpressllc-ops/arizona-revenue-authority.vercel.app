import "server-only";

import { NextResponse } from "next/server";
import {
  qstashIsConfigured,
  verifyQStashSignature,
} from "@/lib/automations/qstash";
import {
  collectHeartbeatStats,
  sendHeartbeat,
} from "@/lib/gitpage/heartbeat";

export const dynamic = "force-dynamic";

/**
 * Daily QStash heartbeat to gitpage: the boot ping payload plus
 * subAccountCount and buildsLastDay. Schedule once:
 *
 *   curl -X POST 'https://qstash.upstash.io/v2/schedules/{base}/api/cron/gitpage-heartbeat' \
 *     -H 'Authorization: Bearer YOUR_QSTASH_TOKEN' \
 *     -H 'Upstash-Cron: 0 3 * * *'
 *
 * Middleware lets this through unauthenticated; the Upstash-Signature check is the auth.
 */
export async function POST(request: Request) {
  if (!qstashIsConfigured()) {
    return NextResponse.json(
      { error: "QStash is not configured." },
      { status: 503 },
    );
  }

  const signature = request.headers.get("upstash-signature");
  if (!signature) {
    return NextResponse.json(
      { error: "Missing Upstash-Signature header" },
      { status: 401 },
    );
  }

  const rawBody = await request.text();
  const valid = await verifyQStashSignature(signature, rawBody);
  if (!valid) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const stats = await collectHeartbeatStats();
  const result = await sendHeartbeat(stats);

  // Cloud-instance ping: no-op unless CLOUD_INSTANCE_ID is set. Swallows its own errors.
  const { sendCloudInstanceHeartbeat } = await import(
    "@/lib/cloud-instance/heartbeat"
  );
  await sendCloudInstanceHeartbeat({
    subAccountCount: stats.subAccountCount,
  }).catch(() => {});

  return NextResponse.json({
    ok: true,
    sent: result !== null,
    agency: result?.gitpageStatus?.agency ?? null,
  });
}
