import "server-only";

import { publishCallback, qstashIsConfigured } from "@/lib/automations/qstash";
import { GitpageError, gitpageIsConfigured, notifyProductsChanged } from "@/lib/gitpage/client";
import { runAfterResponse } from "@/lib/server/after-response";

/**
 * Keeps live website shop pages in step with the catalog: after a public-facing
 * change to a product that was on sale online, gitpage is told to re-sync the
 * sub-account's sites (it reads the products feed, so the notice carries no
 * product data). Best-effort: a failure never blocks the product edit.
 */

export type ProductsChangedReason = "updated" | "archived" | "unlisted";

export const SYNC_NOTIFY_PATH = "/api/products/sync-notify";
/** Edits within this window collapse into one sync. */
const DEBOUNCE_S = 20;

/** Await this from the route; it only queues (or schedules) the notice. */
export async function queueProductsChanged(input: {
  subAccountId: string;
  productId: string;
  reason: ProductsChangedReason;
}): Promise<void> {
  if (!gitpageIsConfigured()) return;
  const body = { subAccountId: input.subAccountId, productIds: [input.productId], reason: input.reason };
  if (qstashIsConfigured()) {
    const bucket = Math.floor(Date.now() / (DEBOUNCE_S * 1000));
    const queued = await publishCallback({
      pathname: SYNC_NOTIFY_PATH,
      body,
      delaySeconds: DEBOUNCE_S,
      // One per workspace per window: gitpage syncs the whole feed, and two
      // notices for the same sites would race on their commits.
      deduplicationId: `psync_${input.subAccountId}_${bucket}`,
    });
    if (queued) return;
  }
  runAfterResponse(() => sendProductsChanged(body).then(() => undefined));
}

/** True when gitpage should be asked again later. Never throws. */
export async function sendProductsChanged(body: {
  subAccountId: string;
  productIds: string[];
  reason: ProductsChangedReason;
}): Promise<{ retry: boolean }> {
  try {
    const res = await notifyProductsChanged(body);
    console.log(
      `[products-sync] sa=${body.subAccountId} ${res.sites.map((s) => `${s.pageId}:${s.status}`).join(" ") || "no sites"}`,
    );
    return { retry: false };
  } catch (err) {
    const status = err instanceof GitpageError ? err.status : 0;
    // 4xx is final (shop pages off for the agency, bad key); 5xx and network errors are worth a retry.
    const retry = status === 0 || status >= 500;
    console.warn(`[products-sync] sa=${body.subAccountId} notice failed (${status || "network"})`, err);
    return { retry };
  }
}
