import "server-only";

import { recordCounter } from "@/lib/server/usage-meter";
import { runAfterResponse } from "@/lib/server/after-response";

/**
 * Firecrawl client. One FIRECRAWL_API_KEY per deployment, shared by all
 * sub-accounts. Scrapes a single page of a sub-account's site for the AI
 * agent's context. Only /scrape is used; /crawl gets expensive fast and the
 * homepage usually has what's needed.
 */

const FIRECRAWL_BASE = "https://api.firecrawl.dev";

export function firecrawlIsConfigured(): boolean {
  return !!process.env.FIRECRAWL_API_KEY?.trim();
}

export class FirecrawlError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "FirecrawlError";
    this.status = status;
  }
}

interface ScrapeResult {
  markdown: string;
  title: string | null;
  sourceUrl: string;
}

/** Which workspace a scrape is counted against (visibility only, never priced). */
export type ScrapeMeter = { subAccountId: string } | { agencyInternal: true };

/** Markdown plus title. Throws FirecrawlError on non-2xx. */
export async function scrapeUrl(
  url: string,
  meter: ScrapeMeter,
): Promise<ScrapeResult> {
  const apiKey = process.env.FIRECRAWL_API_KEY?.trim();
  if (!apiKey) {
    throw new FirecrawlError("FIRECRAWL_API_KEY is not configured", 503);
  }

  const res = await fetch(`${FIRECRAWL_BASE}/v1/scrape`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      url,
      formats: ["markdown"],
      onlyMainContent: true,
    }),
    // 30s ceiling; usually under 10s for one page.
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new FirecrawlError(
      `Firecrawl returned ${res.status}: ${text.slice(0, 200)}`,
      res.status,
    );
  }
  // Firecrawl bills a successful request even when the page has no content.
  if ("subAccountId" in meter) {
    runAfterResponse(() =>
      recordCounter({ subAccountId: meter.subAccountId, counter: "firecrawlScrapes", qty: 1 }),
    );
  }

  const json = (await res.json()) as {
    success?: boolean;
    data?: { markdown?: string; metadata?: { title?: string; sourceURL?: string } };
    error?: string;
  };
  if (!json.success || !json.data?.markdown) {
    throw new FirecrawlError(
      `Firecrawl returned no markdown for ${url}: ${json.error ?? "unknown error"}`,
      502,
    );
  }

  return {
    markdown: json.data.markdown,
    title: json.data.metadata?.title ?? null,
    sourceUrl: json.data.metadata?.sourceURL ?? url,
  };
}
