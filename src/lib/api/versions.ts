/**
 * Public API versions, date-coded Stripe-style. Published versions are frozen;
 * a breaking change ships as a new version and old ones stay supported.
 *
 * Resolution: `LeadStack-Version` header, then the key's `defaultVersion`, then
 * LATEST_API_VERSION. Every response echoes the resolved version.
 */
export const LATEST_API_VERSION = "2026-06-15";

const SUPPORTED_VERSIONS = new Set<string>([LATEST_API_VERSION]);

export function isSupportedVersion(v: string): boolean {
  return SUPPORTED_VERSIONS.has(v);
}

/** null when the caller pinned an unsupported version (route should 400). */
export function resolveVersion(opts: {
  headerVersion: string | null;
  keyDefaultVersion: string | null;
}): { version: string } | { error: string } {
  if (opts.headerVersion) {
    if (!isSupportedVersion(opts.headerVersion)) {
      return {
        error: `Unsupported API version '${opts.headerVersion}'. Supported: ${Array.from(
          SUPPORTED_VERSIONS,
        ).join(", ")}.`,
      };
    }
    return { version: opts.headerVersion };
  }
  if (opts.keyDefaultVersion && isSupportedVersion(opts.keyDefaultVersion)) {
    return { version: opts.keyDefaultVersion };
  }
  return { version: LATEST_API_VERSION };
}
