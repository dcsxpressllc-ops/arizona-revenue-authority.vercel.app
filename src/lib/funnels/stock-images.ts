import "server-only";

/**
 * Stock photos for funnel sections, as hotlinked CDN URLs: the doc stays small
 * and swapping a picture is a text edit. Optional; without PEXELS_API_KEY it
 * returns nothing and the caller shows the brief plus a search link rather
 * than a broken <img>. Pexels because its licence allows commercial use
 * without attribution, which matters on client sales pages.
 */

const PEXELS_SEARCH = "https://api.pexels.com/v1/search";

export function stockImagesConfigured(): boolean {
  return !!process.env.PEXELS_API_KEY?.trim();
}

export interface StockImage {
  /** Sized for a full-width band. */
  url: string;
  /** For operators who want to credit anyway. */
  credit: string;
  sourceUrl: string;
}

/** Never throws; a slow photo service mustn't fail a draft. */
export async function searchStockImages(
  query: string,
  count = 3,
): Promise<StockImage[]> {
  const key = process.env.PEXELS_API_KEY?.trim();
  const q = query.trim();
  if (!key || !q) return [];

  try {
    const url = new URL(PEXELS_SEARCH);
    url.searchParams.set("query", q.slice(0, 120));
    url.searchParams.set("per_page", String(Math.min(Math.max(count, 1), 10)));
    url.searchParams.set("orientation", "landscape");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    const res = await fetch(url, {
      headers: { Authorization: key },
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));

    if (!res.ok) {
      console.warn(`[stock-images] pexels ${res.status} for "${q}"`);
      return [];
    }

    const data = (await res.json()) as {
      photos?: {
        photographer?: string;
        url?: string;
        src?: { landscape?: string; large?: string; original?: string };
      }[];
    };

    return (data.photos ?? [])
      .map((p) => {
        const src = p.src?.landscape || p.src?.large || p.src?.original;
        if (!src) return null;
        return {
          url: src,
          credit: p.photographer ? `${p.photographer} / Pexels` : "Pexels",
          sourceUrl: p.url ?? "https://www.pexels.com",
        } satisfies StockImage;
      })
      .filter((x): x is StockImage => x !== null);
  } catch (err) {
    console.warn("[stock-images] search failed", err);
    return [];
  }
}

/** Shown when no provider key is configured. */
export function stockSearchLink(query: string): string {
  return `https://www.pexels.com/search/${encodeURIComponent(query.trim())}/`;
}
