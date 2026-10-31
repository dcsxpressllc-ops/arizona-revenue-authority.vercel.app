/**
 * Shape and coercion for the deal state on `appConfig/foundersCohort`, shared
 * by the client hook (onSnapshot, live edits) and `deal-state-server.ts`
 * (SSR, so first paint already shows the right price).
 *
 * Both must agree. Without the server seed, visitors see the $891 deal price
 * for the 1-3s the subscription takes and then watch it jump to $1,782; a
 * price that rises on load is the worst first impression.
 *
 * Framework-neutral (no "use client", no server-only) so either side can import it.
 */

import { DEAL } from "@/config/deal";
import {
  DEAL_CONFIG_DEFAULTS,
  isValidTimeZone,
  type DealType,
} from "@/lib/deal-config";

export interface FoundersCohortState {
  soldCount: number;
  currentWave: 1 | 2 | 3;
  slotsTotal: number;
  /** Falls back to DEAL.name. */
  dealName: string;
  /** Falls back to DEAL.memberNoun. */
  memberNoun: string;
  /** Missing = "spots". */
  dealType: DealType;
  /** Epoch ms, null when unset. */
  dealEndsAtMs: number | null;
  /** Only affects how the date is written ("31 July (AEST)"); the countdown is absolute. null = visitor's zone, no label. */
  dealEndsTimeZone: string | null;
  /** e.g. "50% off". */
  offerLabel: string;
  /** Ended deal switches CTAs to the full-price checkout. */
  fullPriceAfterEnd: boolean;
  /** Master "end all deals": retail $1,782 everywhere, now. */
  retailMode: boolean;
  retailBannerMessage: string;
  /**
   * True once the state reflects the real doc (server seed or subscription).
   * Every price/urgency surface gates on it, so never true for guessed defaults.
   */
  hydrated: boolean;
}

/** Compile-time guesses, hence `hydrated: false`. */
export const COHORT_DEFAULTS: FoundersCohortState = {
  soldCount: 0,
  currentWave: 1,
  slotsTotal: DEAL.seatsTotal,
  dealName: DEAL.name,
  memberNoun: DEAL.memberNoun,
  dealType: DEAL_CONFIG_DEFAULTS.dealType,
  dealEndsAtMs: null,
  dealEndsTimeZone: DEAL_CONFIG_DEFAULTS.dealEndsTimeZone,
  offerLabel: DEAL_CONFIG_DEFAULTS.offerLabel,
  fullPriceAfterEnd: DEAL_CONFIG_DEFAULTS.fullPriceAfterEnd,
  retailMode: DEAL_CONFIG_DEFAULTS.retailMode,
  retailBannerMessage: DEAL_CONFIG_DEFAULTS.retailBannerMessage,
  hydrated: false,
};

// Off-Stripe sales (Skool, invoiced) the webhook can't see. Added to the
// Stripe count, capped at slotsTotal. Bump the env per sale outside Stripe.
const MANUAL_SOLD = (() => {
  const raw = process.env.NEXT_PUBLIC_FOUNDERS_MANUAL_SOLD;
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
})();

export function applyManualOffset(
  realFromStripe: number,
  slotsTotal: number,
): number {
  return Math.min(realFromStripe + MANUAL_SOLD, slotsTotal);
}

/** Missing doc (fresh clone, never edited): defaults, but hydrated since "no doc" is a real answer. */
export function emptyCohortState(): FoundersCohortState {
  return {
    ...COHORT_DEFAULTS,
    soldCount: applyManualOffset(0, COHORT_DEFAULTS.slotsTotal),
    hydrated: true,
  };
}

/** Normalizes an untrusted payload. */
export function coerceCohortState(
  data: Record<string, unknown>,
): FoundersCohortState {
  const realSold = typeof data.soldCount === "number" ? data.soldCount : 0;
  const slotsTotal =
    typeof data.slotsTotal === "number" ? data.slotsTotal : DEAL.seatsTotal;
  const endsAtRaw =
    typeof data.dealEndsAt === "string" ? Date.parse(data.dealEndsAt) : NaN;

  return {
    soldCount: applyManualOffset(realSold, slotsTotal),
    currentWave:
      data.currentWave === 2 || data.currentWave === 3 ? data.currentWave : 1,
    slotsTotal,
    dealName:
      typeof data.dealName === "string" && data.dealName.trim()
        ? data.dealName.trim()
        : DEAL.name,
    memberNoun:
      typeof data.memberNoun === "string" && data.memberNoun.trim()
        ? data.memberNoun.trim()
        : DEAL.memberNoun,
    dealType: data.dealType === "countdown" ? "countdown" : "spots",
    dealEndsAtMs: Number.isFinite(endsAtRaw) ? endsAtRaw : null,
    dealEndsTimeZone:
      typeof data.dealEndsTimeZone === "string" &&
      isValidTimeZone(data.dealEndsTimeZone)
        ? data.dealEndsTimeZone
        : null,
    offerLabel:
      typeof data.offerLabel === "string" && data.offerLabel.trim()
        ? data.offerLabel.trim()
        : DEAL_CONFIG_DEFAULTS.offerLabel,
    fullPriceAfterEnd: data.fullPriceAfterEnd === true,
    retailMode: data.retailMode === true,
    retailBannerMessage:
      typeof data.retailBannerMessage === "string" &&
      data.retailBannerMessage.trim()
        ? data.retailBannerMessage.trim()
        : DEAL_CONFIG_DEFAULTS.retailBannerMessage,
    hydrated: true,
  };
}
