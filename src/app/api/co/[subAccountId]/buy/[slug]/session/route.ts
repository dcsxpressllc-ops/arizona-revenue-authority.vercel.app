import "server-only";

import { NextResponse } from "next/server";
import Stripe from "stripe";

import { mapStripeSessionError } from "@/lib/stripe/session-error";
import {
  createCheckoutSessionForSubAccount,
  getSubAccountStripe,
  StripeConnectionError,
} from "@/lib/stripe/sub-account-client";
import { createPendingOrder } from "@/lib/server/orders-service";
import {
  checkCheckoutRateLimit,
  clientIpFrom,
} from "@/lib/checkout/rate-limit";
import {
  deliverySnapshots,
  loadBuyContext,
  sanitizeWebsiteRef,
  websiteReturnUrl,
} from "@/lib/server/product-buy-service";
import type { OrderLineItem } from "@/types/orders";

export const dynamic = "force-dynamic";

/**
 * Express buy link: one product, straight to Stripe Checkout. Unauthenticated,
 * so price, currency, name and images come from Firestore only; the body
 * carries just the display-only websiteRef. Stripe collects email and name,
 * and the webhook reconciles the contact from them once paid.
 */

function fail(message: string, status = 400): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

const UNAVAILABLE = "This item isn't available to buy right now.";

export async function POST(
  request: Request,
  ctx: { params: Promise<{ subAccountId: string; slug: string }> },
) {
  const { subAccountId, slug } = await ctx.params;

  const rate = checkCheckoutRateLimit(clientIpFrom(request));
  if (!rate.ok) {
    return NextResponse.json(
      { error: "Too many attempts. Please try again shortly." },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSec) } },
    );
  }

  let body: { websiteRef?: unknown } = {};
  try {
    body = (await request.json()) as { websiteRef?: unknown };
  } catch {
    // An empty body is fine; websiteRef is optional.
  }

  const buy = await loadBuyContext(subAccountId, slug);
  if (!buy) return fail(UNAVAILABLE, 404);
  // A linked checkout page owns this product's sale (bumps, extra fields).
  if (buy.checkoutPageSlug) return fail(UNAVAILABLE, 409);
  const { product, agencyId } = buy;

  try {
    await getSubAccountStripe(subAccountId);
  } catch (err) {
    if (err instanceof StripeConnectionError) {
      console.error(
        `[buy/session] connection unusable sa=${subAccountId} code=${err.code}`,
      );
      return fail("Payments are temporarily unavailable. Please try again later.", 503);
    }
    throw err;
  }

  const websiteRef = sanitizeWebsiteRef(body.websiteRef);
  const currency = (product.currency || "USD").toLowerCase();
  const lineItems: OrderLineItem[] = [
    {
      productId: product.id,
      name: product.name,
      description: product.description ?? "",
      unitPriceCents: product.unitPriceCents,
      quantity: 1,
      isBump: false,
    },
  ];
  const deliveries = deliverySnapshots([product]);

  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
  const buyPath = `${base}/co/${subAccountId}/buy/${slug}`;
  // Back to the product page on the website when we know it, else our page.
  const back = websiteRef ? await websiteReturnUrl(subAccountId, websiteRef) : null;
  const cancelUrl = back?.url ?? `${buyPath}?cancelled=1`;
  const refQuery = websiteRef?.siteId
    ? `&site=${encodeURIComponent(websiteRef.siteId)}${websiteRef.page ? `&page=${encodeURIComponent(websiteRef.page)}` : ""}`
    : "";

  const delivery = deliveries[0]?.delivery.type;
  const promise =
    delivery === "download"
      ? "Your download link appears right after payment."
      : delivery === "community"
        ? "You'll get a sign-in link by email right after payment."
        : null;

  const images = (product.images ?? []).slice(0, 8).map((img) => img.url);
  const description = (product.publicDescription || product.description || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);

  let session: Stripe.Checkout.Session;
  try {
    session = await createCheckoutSessionForSubAccount({
      subAccountId,
      params: {
        mode: "payment",
        line_items: lineItems.map((li) => ({
          quantity: li.quantity,
          price_data: {
            currency,
            unit_amount: li.unitPriceCents,
            product_data: {
              name: li.name,
              ...(description ? { description } : {}),
              ...(images.length ? { images } : {}),
            },
          },
        })),
        submit_type: "pay",
        locale: "auto",
        name_collection: { individual: { enabled: true } },
        ...(promise ? { custom_text: { submit: { message: promise } } } : {}),
        success_url: `${buyPath}/thanks?session_id={CHECKOUT_SESSION_ID}${refQuery}`,
        cancel_url: cancelUrl,
        metadata: {
          leadstackSubAccountId: subAccountId,
          leadstackProductId: product.id,
        },
      },
    });
  } catch (err) {
    const mapped = mapStripeSessionError(err);
    console.error(
      `[buy/session] stripe session failed sa=${subAccountId} - ${mapped.logDetail}`,
    );
    return fail(mapped.buyerMessage, mapped.status);
  }

  if (!session.url) {
    return fail("Payments are temporarily unavailable. Please try again later.", 502);
  }

  try {
    await createPendingOrder({
      agencyId,
      subAccountId,
      contactId: null,
      checkoutPageId: null,
      source: "product_link",
      currency,
      lineItems,
      stripeCheckoutSessionId: session.id,
      livemode: session.livemode,
      buyerEmail: null,
      buyerName: null,
      attribution: null,
      productLinkProductId: product.id,
      websiteRef,
      deliveries,
    });
  } catch (err) {
    // An unrecorded payment is worse than a failed checkout, so refuse.
    console.error(`[buy/session] pending order write failed sa=${subAccountId}`, err);
    return fail("Payments are temporarily unavailable. Please try again later.", 500);
  }

  return NextResponse.json({ url: session.url });
}
