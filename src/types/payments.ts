/**
 * Sub-account card payments through the client's OWN Stripe account (money
 * never touches the agency). Separate from Client Billing, which runs on the
 * deployment's STRIPE_SECRET_KEY.
 *
 * Currently the operator pastes a restricted key. Stripe Connect isn't built;
 * with direct charges both make the same API calls, so adding it is one branch
 * in `getSubAccountStripe()`.
 *
 * Secret split, don't move fields across it:
 *   - StripeConnectionSecret: `subAccounts/{id}/private/stripeConnection`,
 *     rules deny all (Admin SDK only).
 *   - StripeConnectionMeta: on the sub-account doc, readable by any active
 *     member. Rules are document-level, so nothing secret can go here.
 */

export const STRIPE_CONNECTION_DOC_ID = "stripeConnection";

export function stripeConnectionSecretPath(subAccountId: string): string {
  return `subAccounts/${subAccountId}/private/${STRIPE_CONNECTION_DOC_ID}`;
}

/** Server only. Never returned from an API route. */
export type StripeConnectionSecret =
  | {
      mode: "key";
      /** `rk_live_...` / `rk_test_...` */
      restrictedKey: string;
      /**
       * Signing secret for the endpoint on the client's account. Empty while
       * waiting for a manual paste (when the key can't write webhook endpoints).
       */
      webhookSecret: string;
    }
  | {
      /** Not built. In the union so consumers already have to handle it. */
      mode: "connect";
      connectedAccountId: string;
    };

/** `SubAccountDoc.stripeConnectionMeta`. Safe for members to read. */
export interface StripeConnectionMeta {
  /** Absent on older docs; read as "key". */
  mode: "key" | "connect";
  /**
   * False while a manual webhook secret is outstanding. Checkout must refuse
   * until true, or payments would succeed with nothing listening.
   */
  ready: boolean;
  /** `acct_...`, display only. Null when the key lacks Account read. */
  accountId: string | null;
  accountName: string | null;
  /** False for `rk_test_...`; drives the test-mode badge. */
  livemode: boolean;
  keyLast4: string | null;
  connectedAt: Date;
}

/** A full secret key (`sk_...`) is refused on save. */
export const RESTRICTED_KEY_RE = /^rk_(live|test)_[A-Za-z0-9]+$/;

/** Matches `sk_...` keys so we can give a targeted error. */
export const SECRET_KEY_RE = /^sk_(live|test)_[A-Za-z0-9]+$/;

/**
 * Events the client's account must send us. Registered automatically when
 * the key allows it, otherwise shown for manual endpoint setup.
 */
export const SUB_ACCOUNT_WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "charge.refunded",
  "charge.dispute.created",
] as const;
