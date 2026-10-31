import "server-only";

import { APP_VERSION } from "@/config/version";

/**
 * Cloud-instance heartbeat. Ships in the buyer template but does nothing unless
 * CLOUD_INSTANCE_ID and CLOUD_INSTANCE_TOKEN are set, which only the Cloud
 * provisioner does. Self-hosted deployments never send it.
 *
 * Fired once per cold start (instrumentation.ts) and daily from
 * /api/cron/gitpage-heartbeat. Best-effort; never affects boot or the cron.
 */
export async function sendCloudInstanceHeartbeat(stats?: {
  subAccountCount?: number;
}): Promise<void> {
  const cloudId = process.env.CLOUD_INSTANCE_ID?.trim();
  const token = process.env.CLOUD_INSTANCE_TOKEN?.trim();
  if (!cloudId || !token) return;

  const base = (
    process.env.CLOUD_MOTHERSHIP_URL ?? "https://www.leadstack.dev"
  ).replace(/\/$/, "");

  try {
    await fetch(`${base}/api/cloud/heartbeat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        cloudId,
        version: APP_VERSION,
        ...(stats?.subAccountCount !== undefined
          ? { subAccountCount: stats.subAccountCount }
          : {}),
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.warn("[cloud-instance/heartbeat] report failed", err);
  }
}
