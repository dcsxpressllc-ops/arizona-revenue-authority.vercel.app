/**
 * Runs once per server cold start. Fires a status check to gitpage that
 * caches the website-builder subscription status for the first render.
 *
 * Node.js runtime only: the heartbeat needs firebase-admin, which can't run
 * on the Edge runtime where the middleware lives.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Install API-key log redaction before anything else logs. Idempotent. Masks
  // the secret half of any `lsk_<live|test>_*` token passed to console.*.
  const { installLogRedaction } = await import("./lib/api/redact");
  installLogRedaction();

  // Registers the daily cron schedules in QStash so buyers don't have to create
  // them by hand. Idempotent via stable scheduleIds, cached 24h in a Firestore
  // marker doc.
  const { ensureSchedulesRegistered } = await import(
    "./lib/qstash/register-schedules"
  );

  // Defer the import so Edge bundles never see firebase-admin.
  const { sendHeartbeat } = await import("./lib/gitpage/heartbeat");

  // No-op unless this deployment was provisioned by LeadStack Cloud
  // (CLOUD_INSTANCE_ID set). Inert on self-hosted deployments.
  const { sendCloudInstanceHeartbeat } = await import(
    "./lib/cloud-instance/heartbeat"
  );

  // Awaited, not fire-and-forget: serverless freezes the instance once the
  // response is sent, so a floating promise may never settle and the writes
  // silently never happen. Run concurrently (each has its own timeout) and
  // swallow failures individually so none can block boot.
  await Promise.all([
    ensureSchedulesRegistered().catch((err) => {
      console.warn("[instrumentation] schedule registration failed", err);
    }),
    sendHeartbeat().catch((err) => {
      console.warn("[instrumentation] gitpage heartbeat threw", err);
    }),
    sendCloudInstanceHeartbeat().catch((err) => {
      console.warn("[instrumentation] cloud heartbeat threw", err);
    }),
  ]);
}
