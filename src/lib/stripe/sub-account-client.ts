import "server-only";

import Stripe from "stripe";

import { getAdminDb } from "@/lib/firebase/admin";
import { getStripeServer } from "@/lib/stripe/server";
import {
  stripeConnectionSecretPath,
  type StripeConnectionSecret,
} from "@/types/payments";

/**
 * Every Stripe call made for a sub-account (its own customers paying it) must
 * build its client here, never `new Stripe(key)` inline in a route.
 *
 * With direct charges, Tier 1 (restricted key) and Tier 2 (Connect) make identical calls to
 * the same Stripe account; only client construction differs:
 *
 *   key       new Stripe(restrictedKey).checkout.sessions.create({ ...body })
 *   connect   platformStripe.checkout.sessions.create({ ...body }, { stripeAccount })
 *
 * So Connect is one branch here and nothing above it changes. This is also the
 * only code that reads `restrictedKey`.
 *
 * Not the same as getStripeServer(), which is the agency's own Stripe account
 * (founders checkout, client billing, disputes).
 */

export class StripeConnectionError extends Error {
  readonly code: "not_connected" | "not_ready" | "unsupported_mode";

  constructor(
    code: "not_connected" | "not_ready" | "unsupported_mode",
    message: string,
  ) {
    super(message);
    this.name = "StripeConnectionError";
    this.code = code;
  }
}

export interface SubAccountStripe {
  stripe: Stripe;
  /**
   * Per-request options, or undefined in key mode.
   *
   * Don't pass this as a second argument when undefined/empty. stripe-node only
   * treats a trailing object as options if it has known keys (stripeAccount,
   * apiKey, idempotencyKey...); an empty `{}` throws "Unknown arguments
   * ([object Object])" before the request is sent. Use
   * createCheckoutSessionForSubAccount() instead of wiring it per call site.
   */
  opts: Stripe.RequestOptions | undefined;
  mode: "key" | "connect";
  /** For this sub-account's inbound webhooks. Empty in connect mode (Connect
   *  webhooks verify against the platform secret). */
  webhookSecret: string;
}

/** Reads the server-only secret doc. Null when never connected. */
export async function readStripeConnectionSecret(
  subAccountId: string,
): Promise<StripeConnectionSecret | null> {
  const snap = await getAdminDb().doc(stripeConnectionSecretPath(subAccountId)).get();
  if (!snap.exists) return null;
  const data = snap.data() as Partial<StripeConnectionSecret> | undefined;
  if (!data) return null;

  // Missing `mode` means "key".
  const mode = data.mode ?? "key";
  if (mode === "connect") {
    const id = (data as { connectedAccountId?: string }).connectedAccountId;
    if (!id) return null;
    return { mode: "connect", connectedAccountId: id };
  }

  const key = (data as { restrictedKey?: string }).restrictedKey;
  if (!key) return null;
  return {
    mode: "key",
    restrictedKey: key,
    webhookSecret: (data as { webhookSecret?: string }).webhookSecret ?? "",
  };
}

/**
 * Stripe client bound to one sub-account's own account. Throws
 * StripeConnectionError instead of returning null so nobody can fall through to
 * the agency's Stripe; charging the wrong account is the worst outcome here.
 */
export async function getSubAccountStripe(
  subAccountId: string,
): Promise<SubAccountStripe> {
  const conn = await readStripeConnectionSecret(subAccountId);
  if (!conn) {
    throw new StripeConnectionError(
      "not_connected",
      "This workspace hasn't connected a Stripe account yet.",
    );
  }

  if (conn.mode === "key") {
    if (!conn.webhookSecret) {
      // Without a webhook secret payments would succeed but orders would stay
      // pending forever. Refuse rather than take money blind.
      throw new StripeConnectionError(
        "not_ready",
        "Stripe is connected but its webhook isn't set up yet, so payments couldn't be confirmed. Finish the webhook step in Settings → Payments.",
      );
    }
    return {
      // Key mode authenticates via the client, so no options bag (see `opts`).
      stripe: new Stripe(conn.restrictedKey),
      opts: undefined,
      mode: "key",
      webhookSecret: conn.webhookSecret,
    };
  }

  // Connect: shape is settled but nothing creates a "connect" secret yet.
  return {
    stripe: getStripeServer(),
    opts: { stripeAccount: conn.connectedAccountId },
    mode: "connect",
    webhookSecret: "",
  };
}

/**
 * Create a Checkout Session on the sub-account's own account. Use this instead
 * of getSubAccountStripe() + create(params, opts): it avoids the empty-options
 * "Unknown arguments" throw in key mode, and keeps Connect a one-line change.
 */
export async function createCheckoutSessionForSubAccount(input: {
  subAccountId: string;
  params: Stripe.Checkout.SessionCreateParams;
}): Promise<Stripe.Checkout.Session> {
  const ctx = await getSubAccountStripe(input.subAccountId);
  if (ctx.mode === "connect" && ctx.opts) {
    return ctx.stripe.checkout.sessions.create(input.params, ctx.opts);
  }
  return ctx.stripe.checkout.sessions.create(input.params);
}

/**
 * Probe a restricted key before storing it. Throws Stripe's error (shown to the
 * operator verbatim) if invalid or under-scoped. accounts.retrieve() needs
 * Account read, which is optional; without it we return `{ accountId: null }`
 * instead of blocking the connection.
 */
export async function probeRestrictedKey(restrictedKey: string): Promise<{
  accountId: string | null;
  accountName: string | null;
}> {
  const stripe = new Stripe(restrictedKey);
  try {
    const account = await stripe.accounts.retrieve();
    return {
      accountId: account.id ?? null,
      accountName:
        account.business_profile?.name ??
        account.settings?.dashboard?.display_name ??
        null,
    };
  } catch (err) {
    // A permission error here means no Account read scope, not a bad key; the key
    // itself is checked separately with a scope we do require.
    if (
      err instanceof Stripe.errors.StripeError &&
      err.type === "StripePermissionError"
    ) {
      return { accountId: null, accountName: null };
    }
    throw err;
  }
}
