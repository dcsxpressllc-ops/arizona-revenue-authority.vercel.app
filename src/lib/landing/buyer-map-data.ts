import "server-only";

import { unstable_cache } from "next/cache";
import { getAdminDb } from "@/lib/firebase/admin";
import { COUNTRY_META } from "@/lib/geo/country-meta";
import {
  BUYER_MAP_DATA_TAG,
  BUYER_MAP_REVALIDATE_SECONDS,
} from "@/lib/landing/buyer-map-cache";

/**
 * Server-side aggregate for the landing world map. Groups `purchases` by
 * country and city and returns only an intensity tier (1-5) per place, never
 * raw counts, so per-country purchase numbers can't be read from the response.
 *
 * Landing traffic is high and purchases rare, so this sits in unstable_cache
 * under the `buyer-map` tag with a long safety-net revalidate; the webhook
 * busts the tag per purchase. One scan per purchase regardless of traffic.
 *
 * Purchases without geo (manual, local dev) are skipped. LANDING_SEED_PURCHASES
 * entries (same env as the sales popup) are folded in so the map isn't empty
 * early on.
 */

export interface BuyerMapCity {
  city: string;
  lat: number;
  lng: number;
  /** 1-5 bucket. No raw count. */
  tier: number;
}

export interface BuyerMapCountry {
  code: string;
  /** ISO-3166 alpha-3, the key into src/data/geo/world-countries.json. */
  a3: string;
  name: string;
  continent: string;
  /** 1-5 bucket. No raw count. */
  tier: number;
  /** Densest first. */
  cities: BuyerMapCity[];
}

export interface BuyerMapData {
  totals: { continents: number; countries: number; cities: number };
  /** Countries with at least one purchase, densest first (leaderboard order). */
  countries: BuyerMapCountry[];
}

const EMPTY: BuyerMapData = {
  totals: { continents: 0, countries: 0, cities: 0 },
  countries: [],
};

interface CityAgg {
  count: number;
  latSum: number;
  lngSum: number;
  coordN: number;
}
interface CountryAgg {
  count: number;
  cities: Map<string, CityAgg>;
}

/** {city, country} pairs from LANDING_SEED_PURCHASES; timing ignored. */
function parseSeed(raw: string | undefined): { city: string; country: string }[] {
  if (!raw) return [];
  let entries: unknown;
  try {
    entries = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(entries)) return [];
  const out: { city: string; country: string }[] = [];
  for (const e of entries as Record<string, unknown>[]) {
    if (!e || typeof e !== "object") continue;
    const city = typeof e.city === "string" ? e.city.trim() : "";
    const country = typeof e.country === "string" ? e.country.trim() : "";
    if (!country) continue;
    out.push({ city, country });
  }
  return out;
}

/** count -> tier by rank position, so one dominant country doesn't wash the rest to the floor. */
function makeTierFn(counts: number[]): (n: number) => number {
  if (counts.length <= 1) return () => 3;
  const sorted = [...counts].sort((a, b) => a - b);
  const span = sorted.length - 1;
  return (n) => {
    let idx = sorted.findIndex((v) => v >= n);
    if (idx < 0) idx = span;
    const frac = idx / span;
    return Math.min(5, Math.max(1, Math.round(frac * 4) + 1));
  };
}

/** Deterministic jitter (degrees) so coordinate-less seed cities don't stack on the centroid. */
function jitter(seed: string): [number, number] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  const a = ((h & 0xff) / 255 - 0.5) * 6; // +/-3 degrees
  const b = (((h >> 8) & 0xff) / 255 - 0.5) * 6;
  return [a, b];
}

async function aggregate(minCityBuyers: number): Promise<BuyerMapData> {
  const byCountry = new Map<string, CountryAgg>();

  const bump = (
    rawCountry: string,
    rawCity: string,
    lat: number | null,
    lng: number | null,
  ) => {
    const code = rawCountry.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(code) || !COUNTRY_META[code]) return;
    let c = byCountry.get(code);
    if (!c) {
      c = { count: 0, cities: new Map() };
      byCountry.set(code, c);
    }
    c.count++;
    const city = rawCity.trim();
    if (!city) return;
    let ca = c.cities.get(city);
    if (!ca) {
      ca = { count: 0, latSum: 0, lngSum: 0, coordN: 0 };
      c.cities.set(city, ca);
    }
    ca.count++;
    if (typeof lat === "number" && typeof lng === "number") {
      ca.latSum += lat;
      ca.lngSum += lng;
      ca.coordN++;
    }
  };

  try {
    const snap = await getAdminDb().collection("purchases").get();
    for (const doc of snap.docs) {
      const d = doc.data();
      const country = typeof d.country === "string" ? d.country : "";
      if (!country) continue;
      const city = typeof d.city === "string" ? d.city : "";
      const lat = typeof d.lat === "number" ? d.lat : null;
      const lng = typeof d.lng === "number" ? d.lng : null;
      bump(country, city, lat, lng);
    }
  } catch (err) {
    console.error("[buyer-map-data] purchases scan failed", err);
    // Fall through. Seed entries (if any) can still populate the map.
  }

  for (const { city, country } of parseSeed(process.env.LANDING_SEED_PURCHASES)) {
    bump(country, city, null, null);
  }

  if (byCountry.size === 0) return EMPTY;

  const countryTier = makeTierFn(
    [...byCountry.values()].map((c) => c.count),
  );
  // City tiers come from the pooled distribution across all countries.
  const allCityCounts: number[] = [];
  for (const c of byCountry.values()) {
    for (const ca of c.cities.values()) {
      if (ca.count >= minCityBuyers) allCityCounts.push(ca.count);
    }
  }
  const cityTier = makeTierFn(allCityCounts);

  const continents = new Set<string>();
  let cityCount = 0;

  const countries: BuyerMapCountry[] = [...byCountry.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([code, agg]) => {
      const meta = COUNTRY_META[code];
      continents.add(meta.continent);
      const cities: BuyerMapCity[] = [...agg.cities.entries()]
        .filter(([, ca]) => ca.count >= minCityBuyers)
        .sort((a, b) => b[1].count - a[1].count)
        .map(([name, ca]) => {
          let lat: number;
          let lng: number;
          if (ca.coordN > 0) {
            lat = ca.latSum / ca.coordN;
            lng = ca.lngSum / ca.coordN;
          } else {
            const [dlat, dlng] = jitter(name);
            lat = meta.lat + dlat;
            lng = meta.lng + dlng;
          }
          return { city: name, lat, lng, tier: cityTier(ca.count) };
        });
      cityCount += cities.length;
      return {
        code,
        a3: meta.a3,
        name: meta.name,
        continent: meta.continent,
        tier: countryTier(agg.count),
        cities,
      };
    });

  return {
    totals: {
      continents: continents.size,
      countries: countries.length,
      cities: cityCount,
    },
    countries,
  };
}

/** minCityBuyers is part of the cache key; the `buyer-map` tag busts every variant. */
export async function getBuyerMapData(
  minCityBuyers: number,
): Promise<BuyerMapData> {
  const cached = unstable_cache(
    () => aggregate(minCityBuyers),
    ["buyer-map-data", String(minCityBuyers)],
    { tags: [BUYER_MAP_DATA_TAG], revalidate: BUYER_MAP_REVALIDATE_SECONDS },
  );
  return cached();
}

/**
 * Collective savings vs GoHighLevel = purchases x annualPerBuyer. Only the
 * dollar figure leaves the server, and the per-purchase assumption isn't shown
 * on the page, so it can't be divided back into a headcount. Counts every
 * purchase (geo or not) plus seeds.
 */
async function computeSavings(annualPerBuyer: number): Promise<number> {
  let count = 0;
  try {
    const agg = await getAdminDb().collection("purchases").count().get();
    count = agg.data().count;
  } catch (err) {
    console.error("[buyer-map-data] buyer count failed", err);
  }
  count += parseSeed(process.env.LANDING_SEED_PURCHASES).length;
  return count * Math.max(0, annualPerBuyer);
}

export async function getBuyerSavings(annualPerBuyer: number): Promise<number> {
  const cached = unstable_cache(
    () => computeSavings(annualPerBuyer),
    ["buyer-map-savings", String(annualPerBuyer)],
    { tags: [BUYER_MAP_DATA_TAG], revalidate: BUYER_MAP_REVALIDATE_SECONDS },
  );
  return cached();
}
