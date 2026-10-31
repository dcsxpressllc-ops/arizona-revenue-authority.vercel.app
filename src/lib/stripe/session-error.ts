import "server-only";

import Stripe from "stripe";

/**
 * Error mapper for the public Checkout Session routes (invoice pay, booking
 * deposit, community purchase, checkout page). The customer gets a plain message;
 * the log gets Stripe's type/code/message, since "temporarily unavailable" alone
 * can't be diagnosed.
 *
 * The permission case gets its own message: a restricted key without
 * Prices/Products write fails here and nowhere else (inline price_data creates
 * them), and it has an exact fix.
 */

export interface MappedSessionError {
  /** Safe to show a customer. */
  buyerMessage: string;
  logDetail: string;
  status: number;
  /** Operator must change their restricted-key scopes. */
  isPermission: boolean;
}

export function mapStripeSessionError(err: unknown): MappedSessionError {
  if (err instanceof Stripe.errors.StripeError) {
    const detail = `type=${err.type} code=${err.code ?? "-"} status=${
      err.statusCode ?? "-"
    } message=${err.message}`;

    if (err.type === "StripePermissionError") {
      return {
        buyerMessage:
          "Card payment isn't fully set up on this account yet. Please contact the sender.",
        logDetail:
          `RESTRICTED KEY MISSING PERMISSIONS — creating a Checkout Session with inline ` +
          `price_data also creates a Price and a Product, so the key needs WRITE on ` +
          `Prices and Products (not just read), plus write on Checkout Sessions. ` +
          `Update the key in Stripe → Developers → API keys, then reconnect under ` +
          `Settings → Payments. Stripe said: ${detail}`,
        status: 503,
        isPermission: true,
      };
    }

    if (err.type === "StripeAuthenticationError") {
      return {
        buyerMessage:
          "Card payment isn't available right now. Please contact the sender.",
        logDetail: `Stripe rejected the stored restricted key (revoked or rotated?). ${detail}`,
        status: 503,
        isPermission: true,
      };
    }

    return {
      buyerMessage: "Card payment is temporarily unavailable.",
      logDetail: detail,
      status: 502,
      isPermission: false,
    };
  }

  return {
    buyerMessage: "Card payment is temporarily unavailable.",
    logDetail: err instanceof Error ? err.message : String(err),
    status: 502,
    isPermission: false,
  };
}
