import "server-only";

/**
 * VAPID keys for web push; generate once with `npx web-push generate-vapid-keys`.
 * The public key is NEXT_PUBLIC_* and inlined at build, so redeploy after
 * setting it. Without keys push is off: subscribe routes 503, sends no-op,
 * install still works.
 */
export function pushIsConfigured(): boolean {
  return !!(
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY &&
    process.env.VAPID_PRIVATE_KEY
  );
}

export function getVapidKeys(): { publicKey: string; privateKey: string } {
  return {
    publicKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "",
    privateKey: process.env.VAPID_PRIVATE_KEY ?? "",
  };
}
