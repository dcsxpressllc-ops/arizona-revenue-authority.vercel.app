/**
 * Code defaults for the current campaign's name, member noun and seat count.
 *
 * Defaults only: the live values are edited at /agency/landing (Deal card),
 * which writes dealName/memberNoun/slotsTotal to appConfig/foundersCohort.
 * Every landing surface reads that doc via useFoundersCohort. These values
 * show only until the doc has those fields (fresh clone, no Firebase).
 *
 * Prices ($891 / $1,782) and the pricing-card bullets stay inline in the
 * components on purpose, so the displayed price can't drift from what Stripe
 * charges.
 *
 * Internal plumbing keeps the "founders" name (/api/checkout/founders, the
 * use-founders-* hooks, STRIPE_FOUNDERS_PRICE_ID, appConfig/foundersCohort,
 * Stripe `kind: "founders"` metadata). Renaming would break reconciliation of
 * existing purchases.
 *
 * New campaign: change name/noun/seats in the Deal card, then reset
 * `soldCount` (and `currentWave`) on appConfig/foundersCohort in the Firebase
 * console. The editor never touches those.
 */
/**
 * Stripe Price for the full $1,782 license, used by /api/checkout/founders when
 * "sell at full price after the deal ends" is ticked and the campaign is over.
 * STRIPE_FULL_PRICE_ID overrides per deployment. Price ids aren't secrets.
 */
export const STRIPE_FULL_PRICE_ID_DEFAULT = "price_1Tu26VB4JsHmqRy5OBUrLIyJ";

export const DEAL = {
  /** Headlines, badges, pricing-card title, FAQ. */
  name: "The New Era Deal",

  /** "{sold} of {total} {memberNoun} claimed". */
  memberNoun: "spots",

  /** Code default; see the Firestore override above. */
  seatsTotal: 25,
} as const;

/**
 * Past campaigns that sold out, oldest first, shown as the "deal lineage"
 * ticker above the hero scarcity bar. Static on purpose: when the current deal
 * sells out and a new one starts, append the outgoing name here.
 */
export const PAST_DEALS: ReadonlyArray<{ name: string }> = [
  // Ticker hidden for now; uncomment to show it above the scarcity bar and in the pricing header.
  // { name: "Founders (100) Deal" },
  // { name: "New Era (25) Deal" },
];
