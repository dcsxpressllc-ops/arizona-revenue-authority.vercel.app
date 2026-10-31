/**
 * Channel classification for the landing attribution rollup (YouTube, Google,
 * ads, newsletter, direct), as opposed to geography from the IP lookup.
 *
 * Priority: explicit UTM (trusted verbatim), then ad-click ids (gclid, fbclid)
 * which prove paid traffic without UTMs, then the referrer host, else Direct.
 *
 * Pure so the heartbeat route can call it. `key` is a Firestore-safe id
 * (`[a-z0-9-]`), `label` is for display.
 */

export interface TrafficSource {
  /** Doc id in `landingSources`. */
  key: string;
  label: string;
}

export interface TrafficSignals {
  referrer?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  gclid?: string | null;
  fbclid?: string | null;
}

/** Substring-matched on the referrer host (www.google.com, google.co.uk, news.google.com -> google). First hit wins. */
const HOST_BUCKETS: { match: string; key: string; label: string }[] = [
  { match: "youtube.", key: "youtube", label: "YouTube" },
  { match: "youtu.be", key: "youtube", label: "YouTube" },
  { match: "google.", key: "google", label: "Google (organic)" },
  { match: "bing.", key: "bing", label: "Bing" },
  { match: "duckduckgo.", key: "duckduckgo", label: "DuckDuckGo" },
  { match: "instagram.", key: "instagram", label: "Instagram" },
  { match: "facebook.", key: "facebook", label: "Facebook" },
  { match: "fb.com", key: "facebook", label: "Facebook" },
  { match: "l.facebook", key: "facebook", label: "Facebook" },
  { match: "t.co", key: "twitter", label: "X / Twitter" },
  { match: "twitter.", key: "twitter", label: "X / Twitter" },
  { match: "x.com", key: "twitter", label: "X / Twitter" },
  { match: "linkedin.", key: "linkedin", label: "LinkedIn" },
  { match: "lnkd.in", key: "linkedin", label: "LinkedIn" },
  { match: "reddit.", key: "reddit", label: "Reddit" },
  { match: "tiktok.", key: "tiktok", label: "TikTok" },
  { match: "pinterest.", key: "pinterest", label: "Pinterest" },
  { match: "t.me", key: "telegram", label: "Telegram" },
  { match: "wa.me", key: "whatsapp", label: "WhatsApp" },
  { match: "whatsapp.", key: "whatsapp", label: "WhatsApp" },
  { match: "mail.google", key: "email", label: "Email" },
  { match: "outlook.", key: "email", label: "Email" },
];

/** In-app browsers send `android-app://<package>` (or the bare package) instead of a host. Substring-matched on the lowercased referrer. */
const APP_PACKAGES: { match: string; key: string; label: string }[] = [
  { match: "com.google.android.youtube", key: "youtube", label: "YouTube" },
  {
    match: "com.google.android.googlequicksearchbox",
    key: "google",
    label: "Google (organic)",
  },
  { match: "com.instagram.android", key: "instagram", label: "Instagram" },
  { match: "com.facebook.katana", key: "facebook", label: "Facebook" },
  { match: "com.facebook.lite", key: "facebook", label: "Facebook" },
  { match: "com.zhiliaoapp.musically", key: "tiktok", label: "TikTok" },
  { match: "com.ss.android", key: "tiktok", label: "TikTok" },
  { match: "com.twitter.android", key: "twitter", label: "X / Twitter" },
  { match: "com.linkedin.android", key: "linkedin", label: "LinkedIn" },
  { match: "com.reddit.frontpage", key: "reddit", label: "Reddit" },
  { match: "com.pinterest", key: "pinterest", label: "Pinterest" },
  { match: "org.telegram", key: "telegram", label: "Telegram" },
  { match: "com.whatsapp", key: "whatsapp", label: "WhatsApp" },
];

/** Free text -> Firestore-safe id. */
function toKey(raw: string): string {
  const key = raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return key || "other";
}

/** Title-cases a utm token when there's no nicer label. */
function toLabel(raw: string): string {
  const cleaned = raw.trim().replace(/[-_]+/g, " ");
  return cleaned.slice(0, 60) || "Other";
}

/** Lowercased bare host, or null if unparseable. */
function hostOf(referrer: string | null | undefined): string | null {
  if (!referrer) return null;
  try {
    return new URL(referrer).host.toLowerCase();
  } catch {
    return null;
  }
}

function isPaidMedium(medium: string | null | undefined): boolean {
  if (!medium) return false;
  const m = medium.toLowerCase();
  return (
    m.includes("cpc") ||
    m.includes("ppc") ||
    m.includes("paid") ||
    m.includes("ads") ||
    m === "display"
  );
}

/** Runs on the first heartbeat; the result is stored on the liveVisitor doc so later clicks and the purchase webhook reuse it. */
export function classifyTrafficSource(signals: TrafficSignals): TrafficSource {
  const { referrer, utmSource, utmMedium, gclid, fbclid } = signals;

  if (utmSource && utmSource.trim()) {
    const paid = isPaidMedium(utmMedium);
    const key = toKey(utmSource);
    // Nicer labels for the common paid buckets; anything else is shown as given
    // (utm_source=spring-newsletter -> "Spring newsletter").
    if (key === "google")
      return { key: paid ? "google-ads" : "google", label: paid ? "Google Ads" : "Google (organic)" };
    if (key === "facebook" || key === "fb")
      return { key: paid ? "meta-ads" : "facebook", label: paid ? "Meta Ads" : "Facebook" };
    if (key === "instagram" || key === "ig")
      return { key: paid ? "meta-ads" : "instagram", label: paid ? "Meta Ads" : "Instagram" };
    if (key === "youtube")
      return { key: paid ? "youtube-ads" : "youtube", label: paid ? "YouTube Ads" : "YouTube" };
    return {
      key: paid ? `${key}-ads` : key,
      label: paid ? `${toLabel(utmSource)} Ads` : toLabel(utmSource),
    };
  }

  if (gclid && gclid.trim()) return { key: "google-ads", label: "Google Ads" };
  if (fbclid && fbclid.trim()) return { key: "meta-ads", label: "Meta Ads" };

  // In-app referrers aren't web hosts, so check them before host parsing.
  if (referrer) {
    const raw = referrer.toLowerCase();
    for (const app of APP_PACKAGES) {
      if (raw.includes(app.match)) return { key: app.key, label: app.label };
    }
  }

  const host = hostOf(referrer);
  if (host) {
    for (const bucket of HOST_BUCKETS) {
      if (host.includes(bucket.match)) {
        return { key: bucket.key, label: bucket.label };
      }
    }
    // Unknown site: a referral labelled with the domain.
    const domain = host.replace(/^www\./, "");
    return { key: `ref-${toKey(domain)}`, label: domain };
  }

  // Typed URL, bookmark, or an app that strips the referrer.
  return { key: "direct", label: "Direct" };
}
