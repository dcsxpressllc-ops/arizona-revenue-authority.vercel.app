import "server-only";

import { after } from "next/server";

/**
 * Run background work that must outlive the response. Vercel freezes the
 * function once the route returns, so a bare `void doWork()` gets cut off
 * (intermittently, since it races the response). `after()` keeps it alive.
 *
 * Call this synchronously, before the first `await` on the fire-and-forget
 * path. Next only hands keep-alive to the host on the first `after()` of a
 * request, so registering later, after the response closed, is unprotected.
 * Nesting inside a running `after()` callback is fine.
 *
 * Outside a request scope `after()` throws, so we fall back to plain
 * fire-and-forget. Errors from `fn` are logged, never rethrown.
 */
export function runAfterResponse(fn: () => unknown): void {
  const run = () =>
    Promise.resolve()
      .then(fn)
      .catch((err) => {
        console.warn("[after-response] background task failed", err);
      });
  try {
    after(run);
  } catch {
    void run();
  }
}
