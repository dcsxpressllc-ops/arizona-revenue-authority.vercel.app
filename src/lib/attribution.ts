import type { ContactAttribution } from "@/types/contacts";

/**
 * Reads attribution from the page URL params and referrer, for the hosted form
 * page (/f/[id]) to send with the submission.
 *
 * In an iframe embed this sees the iframe's URL, not the host page's (cross-origin
 * can't read window.parent.location). Put UTMs on the iframe src to pass them through.
 */
export function readAttributionFromBrowser(): ContactAttribution | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const pick = (key: string): string | null => {
    const v = params.get(key);
    return v && v.trim().length > 0 ? v.trim().slice(0, 500) : null;
  };

  const referrer =
    document.referrer && document.referrer.length > 0
      ? document.referrer.slice(0, 500)
      : null;
  const landingPage = window.location.href.slice(0, 500);

  const utmSource = pick("utm_source");
  const utmMedium = pick("utm_medium");
  const utmCampaign = pick("utm_campaign");
  const utmContent = pick("utm_content");
  const utmTerm = pick("utm_term");
  const fbclid = pick("fbclid");
  const gclid = pick("gclid");

  const hasAnyTracking =
    utmSource ||
    utmMedium ||
    utmCampaign ||
    utmContent ||
    utmTerm ||
    fbclid ||
    gclid ||
    referrer;

  if (!hasAnyTracking) return null;

  return {
    utmSource,
    utmMedium,
    utmCampaign,
    utmContent,
    utmTerm,
    fbclid,
    gclid,
    landingPage,
    referrer,
  };
}

type FbqArgs =
  | [event: "init", pixelId: string]
  | [event: "track", eventName: string, params?: Record<string, unknown>];

interface FbqFn {
  (...args: FbqArgs): void;
  callMethod?: (...args: unknown[]) => unknown;
  queue?: unknown[];
}

declare global {
  interface Window {
    fbq?: FbqFn;
  }
}

/** Meta Pixel `Lead` event. No-op when the pixel isn't loaded. */
export function trackLeadEvent(params?: {
  email?: string;
  phone?: string;
  utmCampaign?: string | null;
}) {
  if (typeof window === "undefined" || typeof window.fbq !== "function") {
    return;
  }
  try {
    window.fbq("track", "Lead", {
      content_name: params?.utmCampaign ?? undefined,
    });
  } catch {
    // Pixel errors must never break form submission.
  }
}
