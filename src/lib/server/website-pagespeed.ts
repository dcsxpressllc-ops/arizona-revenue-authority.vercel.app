import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { siteAddress, type WebsiteDoc, type WebsitePageSpeed } from "@/types/website";

/**
 * Mobile PageSpeed Insights for a published site, run ~2 min after publish via
 * QStash and on demand from the site card. Optional PAGESPEED_API_KEY; Google's
 * shared keyless quota is often exhausted (429). Never throws; failures are
 * stored as `pagespeed.error`.
 */

const PSI = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
const CATEGORIES = ["performance", "seo", "accessibility", "best-practices"] as const;

function score(categories: Record<string, { score?: number | null } | undefined>, key: string): number | null {
  const s = categories?.[key]?.score;
  return typeof s === "number" ? Math.round(s * 100) : null;
}

export async function runPageSpeed(subAccountId: string, siteId: string): Promise<WebsitePageSpeed | null> {
  const ref = getAdminDb().doc(`subAccounts/${subAccountId}/website/${siteId}`);
  const snap = await ref.get();
  const site = snap.data() as WebsiteDoc | undefined;
  if (!snap.exists || !site || site.subAccountId !== subAccountId || site.status !== "ready") return null;
  const url = siteAddress(site);
  if (!url) return null;

  const qs = new URLSearchParams({ url, strategy: "mobile" });
  const key = process.env.PAGESPEED_API_KEY?.trim();
  if (key) qs.set("key", key);
  for (const c of CATEGORIES) qs.append("category", c);
  let result: WebsitePageSpeed;
  try {
    const res = await fetch(`${PSI}?${qs.toString()}`, { signal: AbortSignal.timeout(55_000), cache: "no-store" });
    const body = (await res.json().catch(() => ({}))) as {
      lighthouseResult?: { categories?: Record<string, { score?: number | null }> };
      error?: { message?: string };
    };
    if (!res.ok || !body.lighthouseResult?.categories) {
      if (res.status === 429 && !key) {
        throw new Error("Google's free shared quota is used up — add a PAGESPEED_API_KEY to the deployment for reliable checks.");
      }
      throw new Error(body.error?.message || `PageSpeed returned ${res.status}`);
    }
    const cats = body.lighthouseResult.categories;
    result = {
      url,
      strategy: "mobile",
      performance: score(cats, "performance"),
      seo: score(cats, "seo"),
      accessibility: score(cats, "accessibility"),
      bestPractices: score(cats, "best-practices"),
      error: null,
      at: FieldValue.serverTimestamp(),
    };
  } catch (err) {
    result = {
      url,
      strategy: "mobile",
      performance: null,
      seo: null,
      accessibility: null,
      bestPractices: null,
      error: err instanceof Error ? err.message.slice(0, 200) : "PageSpeed check failed",
      at: FieldValue.serverTimestamp(),
    };
  }
  await ref.update({ pagespeed: result, updatedAt: FieldValue.serverTimestamp() });
  return result;
}
