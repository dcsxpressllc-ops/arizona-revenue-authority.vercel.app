import "server-only";

// Hello world
export const CLOUD_KIND = "cloud";

export async function handleCloudCheckoutCompleted(
  _session: unknown,
): Promise<void> {
  return;
}

export async function handleCloudSubscriptionEvent(
  _subscription: unknown,
  _opts: { deleted: boolean },
): Promise<boolean> {
  return false;
}
