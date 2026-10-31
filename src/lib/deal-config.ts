/**
 * Shape and defaults for the live-editable deal campaign: name, urgency
 * mechanic (spots counter or countdown), counter noun, seat count, deadline
 * and offer label shown across the landing.
 *
 * Stored on the existing public `appConfig/foundersCohort` doc that
 * {@link useFoundersCohort} already reads, so no new rules. Written
 * server-side via /api/agency/deal-config. Defaults come from
 * `src/config/deal.ts` until the owner saves once.
 *
 * `dealType` is a single enum, so exactly one mechanic renders:
 *   "spots":     "{sold} of {total} {noun} claimed"
 *   "countdown": "{offerLabel} until {date}". After the deadline the urgency
 *                UI hides but the page keeps selling at the same price.
 *
 * Not here: soldCount / currentWave (owned by the Stripe webhook) and prices
 * (inline in components; see src/config/deal.ts).
 */

import { DEAL } from "@/config/deal";

export type DealType = "spots" | "countdown";

export interface DealConfig {
  dealName: string;
  /** Missing field = "spots". */
  dealType: DealType;
  memberNoun: string;
  /** Live override of DEAL.seatsTotal. */
  slotsTotal: number;
  /** Countdown deadline, ISO-8601 UTC, or null. Ignored in "spots" mode. Past = timer hidden, still selling. */
  dealEndsAt: string | null;
  /**
   * IANA zone the deadline was authored in (e.g. "Australia/Sydney"). The
   * deadline is already a UTC instant, so this never moves the end; it only
   * picks the editor's wall clock and the zone label on the public date.
   * null: editor uses the browser zone, landing shows each visitor's local
   * time without a label.
   */
  dealEndsTimeZone: string | null;
  /** e.g. "50% off". Display copy only, never pricing. */
  offerLabel: string;
  /**
   * When true and the deal has ended (countdown expired or sold out), CTAs go to the
   * full-price $1,782 checkout with the coupon box on; enforced in
   * /api/checkout/founders. When false, an expired countdown keeps selling at
   * the deal price and sold-out spots shows the contact-us card.
   */
  fullPriceAfterEnd: boolean;
  /**
   * Master "end all deals" switch. Flips the landing to retail now, regardless
   * of deadline or spots: every CTA sells $1,782 (server-enforced), urgency UI
   * hides, the bar shows `retailBannerMessage`. Overrides `fullPriceAfterEnd`
   * and `dealHasEnded`. Turning it off restores deal pricing.
   */
  retailMode: boolean;
  /** Announcement bar text while `retailMode` is on (the "$891 · Save 50%" copy would be wrong). */
  retailBannerMessage: string;
}

/** Caps so an untrusted payload can't bloat the doc or break layouts. */
export const DEAL_NAME_MAX = 60;
export const DEAL_MEMBER_NOUN_MAX = 24;
export const DEAL_SEATS_MIN = 1;
export const DEAL_SEATS_MAX = 10000;
export const DEAL_OFFER_LABEL_MAX = 40;
export const RETAIL_BANNER_MAX = 90;

export const DEFAULT_RETAIL_BANNER_MESSAGE =
  "Join the movement — stop renting your software. Own your stack outright.";

export const DEAL_TYPES: readonly DealType[] = ["spots", "countdown"];

/** Used until the owner saves once, or when fields are missing. */
export const DEAL_CONFIG_DEFAULTS: DealConfig = {
  dealName: DEAL.name,
  dealType: "spots",
  memberNoun: DEAL.memberNoun,
  slotsTotal: DEAL.seatsTotal,
  dealEndsAt: null,
  dealEndsTimeZone: null,
  offerLabel: "50% off",
  fullPriceAfterEnd: false,
  retailMode: false,
  retailBannerMessage: DEFAULT_RETAIL_BANNER_MESSAGE,
};

// Countdown timezone. The deadline is a UTC instant, so everyone counts down
// to the same moment; the zone only affects which wall clock the owner types
// in and how the public "until <date> (AEST)" line renders. Plain Intl, client-safe.

/**
 * Short curated list; the full IANA set (~400) is unusable in a native select.
 * Any other valid id on the doc still round-trips, and the editor appends the
 * operator's detected zone if it's missing.
 */
export const DEAL_TIME_ZONES: ReadonlyArray<{ id: string; label: string }> = [
  { id: "Australia/Sydney", label: "Sydney / Melbourne — AEST/AEDT" },
  { id: "Australia/Brisbane", label: "Brisbane — AEST" },
  { id: "Australia/Adelaide", label: "Adelaide — ACST/ACDT" },
  { id: "Australia/Perth", label: "Perth — AWST" },
  { id: "Pacific/Auckland", label: "Auckland — NZST/NZDT" },
  { id: "America/Los_Angeles", label: "Los Angeles — Pacific" },
  { id: "America/Denver", label: "Denver — Mountain" },
  { id: "America/Chicago", label: "Chicago — Central" },
  { id: "America/New_York", label: "New York — Eastern" },
  { id: "America/Sao_Paulo", label: "São Paulo — BRT" },
  { id: "Europe/London", label: "London — GMT/BST" },
  { id: "Europe/Berlin", label: "Berlin / Paris — CET/CEST" },
  { id: "Asia/Dubai", label: "Dubai — GST" },
  { id: "Asia/Kolkata", label: "India — IST" },
  { id: "Asia/Singapore", label: "Singapore" },
  { id: "Asia/Tokyo", label: "Tokyo — JST" },
  { id: "UTC", label: "UTC" },
];

export function isValidTimeZone(id: string): boolean {
  if (!id.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: id });
    return true;
  } catch {
    return false;
  }
}

/** Runtime's own zone (the browser's on the client). "UTC" on failure. */
export function detectTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

const partsFormatterCache = new Map<string, Intl.DateTimeFormat>();

/** Calendar/clock fields of `atMs` as seen in `timeZone`. */
function zonedParts(timeZone: string, atMs: number) {
  let dtf = partsFormatterCache.get(timeZone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partsFormatterCache.set(timeZone, dtf);
  }
  const parts = dtf.formatToParts(new Date(atMs));
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

/** UTC offset in ms at `atMs` (DST-aware). */
function zoneOffsetMs(timeZone: string, atMs: number): number {
  const p = zonedParts(timeZone, atMs);
  const asIfUtc = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour,
    p.minute,
    p.second,
  );
  return asIfUtc - Math.floor(atMs / 1000) * 1000;
}

const WALL_CLOCK_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;

/**
 * datetime-local value ("YYYY-MM-DDTHH:mm") read as wall clock in `timeZone`
 * -> UTC ms. Two passes because the offset depends on the instant being
 * solved for; the second settles DST jumps.
 */
export function wallClockToUtcMs(
  value: string,
  timeZone: string,
): number | null {
  const m = WALL_CLOCK_RE.exec(value);
  if (!m) return null;
  const asIfUtc = Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
  );
  if (!Number.isFinite(asIfUtc)) return null;
  const firstGuess = asIfUtc - zoneOffsetMs(timeZone, asIfUtc);
  return asIfUtc - zoneOffsetMs(timeZone, firstGuess);
}

/** UTC ms -> datetime-local value in `timeZone`. */
export function utcMsToWallClock(atMs: number, timeZone: string): string {
  const p = zonedParts(timeZone, atMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

// No one locale abbreviates every zone (en-US gives Sydney "GMT+10", en-AU
// gives LA "GMT-7"), so try each and fall back to the offset.
const ABBREVIATION_LOCALES = ["en-AU", "en-US", "en-GB"];

const zoneNameFormatterCache = new Map<string, Intl.DateTimeFormat | null>();

/**
 * Short zone name at an instant: "AEST", "PDT", "GMT", "GMT+8". Formatters are
 * cached because the landing recomputes this every countdown tick.
 */
export function timeZoneAbbreviation(timeZone: string, atMs: number): string {
  const at = new Date(atMs);
  const read = (locale: string, name: "short" | "shortOffset") => {
    const key = `${locale}|${timeZone}|${name}`;
    let dtf = zoneNameFormatterCache.get(key);
    if (dtf === undefined) {
      try {
        dtf = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: name });
      } catch {
        dtf = null; // invalid zone, or no `shortOffset` support
      }
      zoneNameFormatterCache.set(key, dtf);
    }
    return dtf?.formatToParts(at).find((p) => p.type === "timeZoneName")?.value;
  };
  for (const locale of ABBREVIATION_LOCALES) {
    const value = read(locale, "short");
    // Bare "GMT"/"UTC" is a real abbreviation (London in winter); an offset
    // suffix means this locale has no name for the zone.
    if (value && !/^(GMT|UTC)[+-]/.test(value)) return value;
  }
  return read("en-GB", "shortOffset") ?? read("en-GB", "short") ?? "";
}

function coerceDealEndsAt(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/** Normalizes an untrusted Firestore payload to a complete config. */
export function coerceDealConfig(
  data: Record<string, unknown> | undefined | null,
): DealConfig {
  if (!data) return { ...DEAL_CONFIG_DEFAULTS };

  const dealName =
    typeof data.dealName === "string" && data.dealName.trim()
      ? data.dealName.trim().slice(0, DEAL_NAME_MAX)
      : DEAL_CONFIG_DEFAULTS.dealName;

  const dealType: DealType =
    data.dealType === "countdown" ? "countdown" : "spots";

  const memberNoun =
    typeof data.memberNoun === "string" && data.memberNoun.trim()
      ? data.memberNoun.trim().slice(0, DEAL_MEMBER_NOUN_MAX)
      : DEAL_CONFIG_DEFAULTS.memberNoun;

  const rawSlots = data.slotsTotal;
  const slotsTotal =
    typeof rawSlots === "number" &&
    Number.isInteger(rawSlots) &&
    rawSlots >= DEAL_SEATS_MIN &&
    rawSlots <= DEAL_SEATS_MAX
      ? rawSlots
      : DEAL_CONFIG_DEFAULTS.slotsTotal;

  const dealEndsAt = coerceDealEndsAt(data.dealEndsAt);

  const dealEndsTimeZone =
    typeof data.dealEndsTimeZone === "string" &&
    isValidTimeZone(data.dealEndsTimeZone)
      ? data.dealEndsTimeZone
      : null;

  const offerLabel =
    typeof data.offerLabel === "string" && data.offerLabel.trim()
      ? data.offerLabel.trim().slice(0, DEAL_OFFER_LABEL_MAX)
      : DEAL_CONFIG_DEFAULTS.offerLabel;

  const retailBannerMessage =
    typeof data.retailBannerMessage === "string" &&
    data.retailBannerMessage.trim()
      ? data.retailBannerMessage.trim().slice(0, RETAIL_BANNER_MAX)
      : DEAL_CONFIG_DEFAULTS.retailBannerMessage;

  return {
    dealName,
    dealType,
    memberNoun,
    slotsTotal,
    dealEndsAt,
    dealEndsTimeZone,
    offerLabel,
    fullPriceAfterEnd: data.fullPriceAfterEnd === true,
    retailMode: data.retailMode === true,
    retailBannerMessage,
  };
}

/**
 * Ended for full-price purposes: deadline passed (countdown) or sold out
 * (spots). `soldCount` should already include any manual offset
 * (NEXT_PUBLIC_FOUNDERS_MANUAL_SOLD).
 */
export function dealHasEnded(
  config: Pick<DealConfig, "dealType" | "dealEndsAt" | "slotsTotal">,
  soldCount: number,
  nowMs: number,
): boolean {
  if (config.dealType === "countdown") {
    if (!config.dealEndsAt) return false;
    const ms = Date.parse(config.dealEndsAt);
    return Number.isFinite(ms) && ms <= nowMs;
  }
  return soldCount >= config.slotsTotal;
}
