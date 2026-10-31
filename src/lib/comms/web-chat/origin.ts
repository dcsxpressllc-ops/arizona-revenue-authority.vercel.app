import "server-only";

/**
 * Origin enforcement for public /api/web-chat/* endpoints. The snippet's
 * sub-account id is public, so the allowlist is what stops someone proxying
 * the widget to drain the token budget.
 *
 * Exact, case-insensitive hostname match (no wildcards). An empty allowlist
 * is "test mode": only localhost/127.0.0.1 and the app's own domain, so a new
 * channel works while being configured without accepting random origins.
 */

/** Strips protocol, port, path. null if unparseable. */
export function hostnameFromOrigin(origin: string | null): string | null {
  if (!origin) return null;
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Like hostnameFromOrigin, but also takes a bare hostname ("example.com"). */
function normaliseEntry(entry: string): string | null {
  const trimmed = entry.trim().toLowerCase();
  if (!trimmed) return null;
  if (trimmed.includes("://")) {
    try {
      return new URL(trimmed).hostname;
    } catch {
      return null;
    }
  }
  return trimmed.replace(/^https?:\/\//, "").split("/")[0]!.split(":")[0]!;
}

export interface OriginCheckResult {
  allowed: boolean;
  reason: "allowlisted" | "test-mode-local" | "blocked" | "missing-origin";
  hostname: string | null;
}

export function checkOriginAllowed(
  origin: string | null,
  allowedDomains: string[],
): OriginCheckResult {
  const hostname = hostnameFromOrigin(origin);
  if (!hostname) {
    return { allowed: false, reason: "missing-origin", hostname: null };
  }

  if (allowedDomains.length > 0) {
    const normalised = allowedDomains
      .map(normaliseEntry)
      .filter((s): s is string => !!s);
    if (normalised.includes(hostname)) {
      return { allowed: true, reason: "allowlisted", hostname };
    }
    return { allowed: false, reason: "blocked", hostname };
  }

  // Empty allowlist: loopback and our own domain only.
  const appHost = hostnameFromOrigin(
    process.env.NEXT_PUBLIC_APP_URL ?? null,
  );
  const testModeAllowed =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0" ||
    (appHost && hostname === appHost);
  if (testModeAllowed) {
    return { allowed: true, reason: "test-mode-local", hostname };
  }
  return { allowed: false, reason: "blocked", hostname };
}
