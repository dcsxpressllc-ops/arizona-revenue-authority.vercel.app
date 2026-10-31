/**
 * Which automation tool a webhook URL belongs to, for tool-specific advice. The
 * big one is n8n: the Test URL (`/webhook-test/`) only receives while the editor
 * is listening, and the Production URL (`/webhook/`) only once the workflow is
 * Active. A Test URL verifies fine and then silently stops.
 */
export interface AutomationUrlInfo {
  tool: "n8n" | "make" | "zapier" | null;
  /** Only set for n8n-shaped URLs. */
  n8nKind?: "test" | "production";
}

export function detectAutomationUrl(raw: string): AutomationUrlInfo {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { tool: null };
  }
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();

  // `/webhook-test/` is n8n-specific whatever the hostname (self-hosted instances
  // rarely have "n8n" in the domain).
  if (path.includes("/webhook-test/")) {
    return { tool: "n8n", n8nKind: "test" };
  }
  if (path.includes("/webhook/") && (host.includes("n8n") || /\/webhook\/[0-9a-f-]{20,}/.test(path))) {
    return { tool: "n8n", n8nKind: "production" };
  }
  if (/^hook\.[a-z0-9-]+\.make\.com$/.test(host)) return { tool: "make" };
  if (host === "hooks.zapier.com") return { tool: "zapier" };
  return { tool: null };
}

/** Same path, `/webhook/` instead of `/webhook-test/`. */
export function n8nProductionUrl(testUrl: string): string {
  return testUrl.replace("/webhook-test/", "/webhook/");
}

/** Destination URL rules shared by the management route and the AI Suite
 *  create_webhook capability: http/https only (https in production except
 *  localhost), and no private/loopback hosts in production (SSRF). */
export function validateWebhookUrl(
  raw: string,
): { ok: true; url: string } | { ok: false; error: string } {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return { ok: false, error: "URL must use http or https." };
    }
    if (
      url.protocol === "http:" &&
      process.env.NODE_ENV === "production" &&
      !url.hostname.endsWith(".localhost") &&
      url.hostname !== "localhost"
    ) {
      return { ok: false, error: "Production URLs must use https." };
    }
    // SSRF guard.
    if (process.env.NODE_ENV === "production") {
      const h = url.hostname;
      if (
        h === "localhost" ||
        h === "0.0.0.0" ||
        h.endsWith(".localhost") ||
        /^127\./.test(h) ||
        /^10\./.test(h) ||
        /^192\.168\./.test(h) ||
        /^172\.(1[6-9]|2[0-9]|3[01])\./.test(h) ||
        /^169\.254\./.test(h)
      ) {
        return { ok: false, error: "Private / loopback hostnames are not allowed." };
      }
    }
    return { ok: true, url: url.toString() };
  } catch {
    return { ok: false, error: "Invalid URL." };
  }
}
