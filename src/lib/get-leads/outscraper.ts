import "server-only";

import type { GetLeadsBusiness } from "@/types/get-leads";

/**
 * Outscraper client for Get Leads. One OUTSCRAPER_API_KEY per deployment,
 * shared by all sub-accounts (like Firecrawl/gitpage). Google Maps search with
 * leads_n_contacts enrichment (emails and socials scraped by Outscraper).
 *
 * Enriched searches take 1-3 minutes, so it's async: submitSearch() returns a
 * request id and fetchResults() polls until Pending turns to Success/Failure.
 * Outscraper keeps results ~4 hours; we never store them (imports are the
 * only durable output).
 */

const OUTSCRAPER_BASE = "https://api.outscraper.cloud";

export function outscraperIsConfigured(): boolean {
  return !!process.env.OUTSCRAPER_API_KEY?.trim();
}

export class OutscraperError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "OutscraperError";
    this.status = status;
  }
}

function requireApiKey(): string {
  const apiKey = process.env.OUTSCRAPER_API_KEY?.trim();
  if (!apiKey) {
    throw new OutscraperError("OUTSCRAPER_API_KEY is not configured", 503);
  }
  return apiKey;
}

/** Returns the request id for fetchResults(). Throws OutscraperError on non-2xx. */
export async function submitSearch(params: {
  query: string;
  latitude: number;
  longitude: number;
  limit: number;
  enrich: boolean;
}): Promise<string> {
  const apiKey = requireApiKey();

  const url = new URL(`${OUTSCRAPER_BASE}/google-maps-search`);
  url.searchParams.set("query", params.query);
  // Maps ranks by proximity rather than a true radius; we distance-filter afterwards.
  url.searchParams.set("coordinates", `${params.latitude},${params.longitude}`);
  url.searchParams.set("limit", String(params.limit));
  url.searchParams.set("language", "en");
  url.searchParams.set("async", "true");
  url.searchParams.set("dropDuplicates", "true");
  if (params.enrich) {
    url.searchParams.set("enrichment", "leads_n_contacts");
  }

  const res = await fetch(url, {
    headers: { "X-API-KEY": apiKey },
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new OutscraperError(
      `Outscraper returned ${res.status}: ${text.slice(0, 200)}`,
      res.status,
    );
  }

  const json = (await res.json()) as { id?: string };
  if (!json.id) {
    throw new OutscraperError("Outscraper returned no request id", 502);
  }
  return json.id;
}

export type OutscraperPoll =
  | { status: "pending" }
  | { status: "failed"; message: string }
  | { status: "success"; businesses: GetLeadsBusiness[] };

/** Response is {status, data} where data has one inner array per query (we always send one). */
export async function fetchResults(requestId: string): Promise<OutscraperPoll> {
  const apiKey = requireApiKey();

  // The id goes into our URL path; don't let it smuggle in path segments.
  if (!/^[\w-]+$/.test(requestId)) {
    throw new OutscraperError("Malformed request id", 400);
  }

  const res = await fetch(`${OUTSCRAPER_BASE}/requests/${requestId}`, {
    headers: { "X-API-KEY": apiKey },
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new OutscraperError(
      `Outscraper returned ${res.status}: ${text.slice(0, 200)}`,
      res.status,
    );
  }

  const json = (await res.json()) as {
    status?: string;
    data?: unknown;
  };

  const status = (json.status ?? "").toLowerCase();
  if (status === "pending") return { status: "pending" };
  if (status !== "success") {
    return { status: "failed", message: `Outscraper request ${json.status ?? "unknown"}` };
  }

  const rows: Record<string, unknown>[] = Array.isArray(json.data)
    ? (json.data as unknown[]).flat().filter(
        (r): r is Record<string, unknown> => !!r && typeof r === "object",
      )
    : [];

  return { status: "success", businesses: rows.map(normalizeBusiness) };
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/**
 * One raw place row -> our wire format (Outscraper's snake_case Maps schema;
 * enrichment adds email_1..3 and socials). Defensive: enrichment fields are
 * often missing and minor fields move around.
 */
function normalizeBusiness(raw: Record<string, unknown>): GetLeadsBusiness {
  const name = str(raw.name) ?? "Unknown business";
  return {
    placeId:
      str(raw.place_id) ??
      str(raw.google_id) ??
      `${name}:${num(raw.latitude) ?? ""},${num(raw.longitude) ?? ""}`,
    name,
    category: str(raw.category) ?? str(raw.type),
    fullAddress: str(raw.full_address) ?? str(raw.address),
    city: str(raw.city),
    phone: str(raw.phone),
    website: str(raw.site),
    email: str(raw.email_1) ?? str(raw.email_2) ?? str(raw.email_3),
    facebook: str(raw.facebook),
    instagram: str(raw.instagram),
    rating: num(raw.rating),
    reviewsCount: num(raw.reviews),
    latitude: num(raw.latitude),
    longitude: num(raw.longitude),
  };
}
