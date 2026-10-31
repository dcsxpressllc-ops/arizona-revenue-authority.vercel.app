import "server-only";

import { FieldValue, type Firestore } from "firebase-admin/firestore";
import type { TrafficSource } from "@/lib/landing/traffic-source";

/**
 * Durable attribution rollups for the landing funnel. `liveVisitors/*` docs
 * expire after ~30s and keep no history, so these server-written aggregates do:
 *   landingSources/{sourceKey}   by channel (YouTube, Google, Direct...)
 *   landingGeo/{countryCode}     by country, with a nested `cities` map
 *
 * Each holds { views, clicks, purchases }, bumped once per session per stage:
 * view on the first heartbeat, click on the first Buy click, purchase from
 * the Stripe webhook by session id. Country comes from the heartbeat's
 * existing geo lookup, no extra ipapi call. Both collections are server-only
 * (Admin SDK writes, the dashboard reads them server-side).
 *
 * Best-effort: callers swallow errors so a miscount never breaks a heartbeat
 * or purchase.
 */

export type LandingFunnelStage = "views" | "clicks" | "purchases";

export interface GeoBucket {
  countryCode: string | null;
  country: string | null;
  city: string | null;
  lat: number | null;
  lng: number | null;
}

/** Map key, not a field path, so dots are fine; just trim + cap. Empty -> null. */
function cityKey(city: string | null): string | null {
  if (!city) return null;
  const trimmed = city.trim().slice(0, 60);
  return trimmed || null;
}

/** Sentinel id for unresolved geo so those visits still count. */
function countryDocId(code: string | null): string {
  if (!code) return "ZZ";
  const upper = code.toUpperCase().replace(/[^A-Z]/g, "");
  return /^[A-Z]{2}$/.test(upper) ? upper : "ZZ";
}

/** Bumps one stage on both the source and geo rollups. */
export async function bumpLandingAttribution(
  db: Firestore,
  stage: LandingFunnelStage,
  source: TrafficSource,
  geo: GeoBucket,
): Promise<void> {
  const inc = FieldValue.increment(1);
  const now = FieldValue.serverTimestamp();

  const sourceRef = db.doc(`landingSources/${source.key}`);
  const sourceWrite = sourceRef.set(
    {
      key: source.key,
      label: source.label,
      [stage]: inc,
      updatedAt: now,
    },
    { merge: true },
  );

  // Geo: country doc + nested city map
  const geoId = countryDocId(geo.countryCode);
  const geoRef = db.doc(`landingGeo/${geoId}`);
  const city = cityKey(geo.city);
  const geoPayload: Record<string, unknown> = {
    countryCode: geoId,
    country: geo.country ?? null,
    lat: typeof geo.lat === "number" ? geo.lat : null,
    lng: typeof geo.lng === "number" ? geo.lng : null,
    [stage]: inc,
    updatedAt: now,
  };
  if (city) {
    // Nested object rather than a dotted path so a "." in a city name isn't read
    // as a sub-field. merge:true deep-merges and the increment hits the leaf.
    geoPayload.cities = { [city]: { [stage]: inc } };
  }
  const geoWrite = geoRef.set(geoPayload, { merge: true });

  await Promise.all([sourceWrite, geoWrite]);
}
