import "server-only";

import { NextResponse } from "next/server";
import Stripe from "stripe";

import { getAdminDb } from "@/lib/firebase/admin";
import { mapStripeSessionError } from "@/lib/stripe/session-error";
import {
  createCheckoutSessionForSubAccount,
  getSubAccountStripe,
  StripeConnectionError,
} from "@/lib/stripe/sub-account-client";
import { createPendingOrder } from "@/lib/server/orders-service";
import { deliverySnapshots } from "@/lib/server/product-buy-service";
import { reconcileContactFromCapture } from "@/lib/comms/ai/capture";
import {
  checkCheckoutRateLimit,
  clientIpFrom,
} from "@/lib/checkout/rate-limit";
import type { CheckoutPage } from "@/types/checkout-pages";
import type { Product } from "@/types/products";
import type { OrderLineItem } from "@/types/orders";

export const dynamic = "force-dynamic";

/**
 * Public checkout: create the Stripe Checkout Session for a page.
 * Unauthenticated (buyers aren't logged in), so nothing about money comes from
 * the body. The client sends only ticked bumps and contact details; prices,
 * currency, names and the eligible bump set are read from Firestore. A
 * tampered body can at most pick a different subset of the page's bumps.
 * The pending order is written before the buyer can pay, so the webhook
 * always has a row to reconcile against.
 */

interface PostBody {
  // Validated against the page's own bump list.
  bumpProductIds?: string[];
  // Funnel slug the buyer came from; Stripe returns them to that funnel's
  // thank-you step. Never a URL: the destination is rebuilt from our origin,
  // so this can't become an open redirect.
  funnelSlug?: string;
  name?: string;
  email?: string;
  phone?: string;
}

function fail(message: string, status = 400): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

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

  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return fail("Invalid request.");
  }

  const db = getAdminDb();

  const subSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  if (!subSnap.exists) return fail("This checkout link isn't available.", 404);
  const sub = subSnap.data() ?? {};
  if (sub.paymentsEnabledByAgency !== true) {
    // Gate turned off after publishing. Plain 404; the buyer isn't the
    // audience for a billing message.
    return fail("This checkout link isn't available.", 404);
  }
  const agencyId = sub.agencyId as string | undefined;
  if (!agencyId) return fail("This checkout link isn't available.", 404);

  const pageSnap = await db
    .collection(`subAccounts/${subAccountId}/checkoutPages`)
    .where("slug", "==", slug)
    .limit(1)
    .get();
  if (pageSnap.empty) return fail("This checkout link isn't available.", 404);
  const page = {
    id: pageSnap.docs[0].id,
    ...(pageSnap.docs[0].data() as Omit<CheckoutPage, "id">),
  };
  if (page.status !== "published") {
    return fail("This checkout link isn't available.", 404);
  }

  // Products are read server-side, never from the body.
  const mainSnap = await db.doc(`products/${page.productId}`).get();
  if (!mainSnap.exists) return fail("This offer is no longer available.", 409);
  const main = mainSnap.data() as Product;
  if (main.subAccountId !== subAccountId || !main.active) {
    return fail("This offer is no longer available.", 409);
  }

  // Only bumps the page lists are honoured; stops a crafted body attaching
  // an arbitrary (or zero-priced) product.
  const requested = Array.isArray(body.bumpProductIds)
    ? [...new Set(body.bumpProductIds.filter((s) => typeof s === "string"))]
    : [];
  const allowedBumpIds = requested.filter((id) =>
    page.bumpProductIds.includes(id),
  );

  const bumps: Product[] = [];
  for (const id of allowedBumpIds) {
    const snap = await db.doc(`products/${id}`).get();
    if (!snap.exists) continue;
    const p = snap.data() as Product;
    // Re-check: the page may predate an archive or a currency change.
    if (
      p.subAccountId !== subAccountId ||
      !p.active ||
      p.bumpEligible !== true ||
      (p.currency || "USD").toUpperCase() !== (main.currency || "USD").toUpperCase()
    ) {
      continue;
    }
    bumps.push({ ...p, id });
  }

  const currency = (main.currency || "USD").toLowerCase();
  const lineItems: OrderLineItem[] = [
    {
      productId: page.productId,
      name: main.name,
      description: main.description ?? "",
      unitPriceCents: main.unitPriceCents,
      quantity: 1,
      isBump: false,
    },
    ...bumps.map((b) => ({
      productId: b.id,
      name: b.name,
      description: b.bumpHeadline || b.description || "",
      unitPriceCents: b.unitPriceCents,
      quantity: 1,
      isBump: true,
    })),
  ];

  // Pre-flight so a disconnected workspace or unfinished webhook fails with a
  // specific log line instead of a generic session error.
  try {
    await getSubAccountStripe(subAccountId);
  } catch (err) {
    if (err instanceof StripeConnectionError) {
      console.error(
        `[co/session] connection unusable sa=${subAccountId} code=${err.code}`,
      );
      // Generic on purpose; the buyer can't fix the operator's Stripe setup.
      return fail(
        "Payments are temporarily unavailable. Please try again later.",
        503,
      );
    }
    throw err;
  }

  const email = (body.email ?? "").trim().toLowerCase().slice(0, 200);
  const phone = (body.phone ?? "").trim().slice(0, 40);
  const name = (body.name ?? "").trim().slice(0, 200);

  let contactId: string | null = null;
  if (email || phone) {
    try {
      // Email-first (an email on the web is typed deliberately). The shared
      // reconciler keeps repeat buyers from becoming duplicates.
      const res = await reconcileContactFromCapture({
        agencyId,
        subAccountId,
        existingContactId: null,
        pageUrl: request.headers.get("referer"),
        source: "checkout",
        matchStrategy: "email-first",
        capture: { name: name || null, email: email || null, phone: phone || null },
      });
      contactId = res?.contactId ?? null;
    } catch (err) {
      // Never block the sale on this; the webhook still has the buyer's
      // Stripe email.
      console.warn("[co/session] contact reconcile failed", err);
    }
  }

  if (contactId && (page.autoTags.length || page.pipelineStageId)) {
    try {
      const patch: Record<string, unknown> = {};
      if (page.autoTags.length) {
        const cur = await db.doc(`contacts/${contactId}`).get();
        const existing = (cur.data()?.tags as string[] | undefined) ?? [];
        patch.tags = [...new Set([...existing, ...page.autoTags])];
      }
      if (Object.keys(patch).length) {
        await db.doc(`contacts/${contactId}`).set(patch, { merge: true });
      }
    } catch (err) {
      console.warn("[co/session] contact tagging failed", err);
    }
  }

  const attribution = contactId
    ? ((await db.doc(`contacts/${contactId}`).get()).data()?.attribution ?? null)
    : null;

  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
  // A funnel return hop wins over the page's success URL. Re-slugified and
  // rebuilt from our origin + a fixed path, so no posted value can make this
  // an open redirect.
  const funnelSlug = (body.funnelSlug ?? "")
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 60);
  const successUrl = funnelSlug
    ? `${base}/fn/${subAccountId}/${funnelSlug}/thanks`
    : (page.successUrl ?? `${base}/co/${subAccountId}/${slug}/thanks`);
  const cancelUrl = `${base}/co/${subAccountId}/${slug}?cancelled=1`;

  let session: Stripe.Checkout.Session;
  try {
    session = await createCheckoutSessionForSubAccount({
      subAccountId: subAccountId,
      params: {
        mode: "payment",
        line_items: lineItems.map((li) => ({
          quantity: li.quantity,
          price_data: {
            currency,
            unit_amount: li.unitPriceCents,
            product_data: {
              name: li.name,
              ...(li.description ? { description: li.description } : {}),
            },
          },
        })),
        ...(email ? { customer_email: email } : {}),
        success_url: successUrl,
        cancel_url: cancelUrl,
        // For cross-checking/debugging only; orders match on session id.
        metadata: {
          leadstackSubAccountId: subAccountId,
          leadstackCheckoutPageId: page.id,
        },
      },
    });
  } catch (err) {
    const mapped = mapStripeSessionError(err);
    console.error(
      `[co/session] stripe session failed sa=${subAccountId} — ${mapped.logDetail}`,
    );
    return fail(mapped.buyerMessage, mapped.status);
  }

  if (!session.url) {
    return fail("Payments are temporarily unavailable. Please try again later.", 502);
  }

  // After the session exists (we need its id) but before Stripe's page has
  // been opened.
  try {
    await createPendingOrder({
      agencyId,
      subAccountId,
      contactId,
      checkoutPageId: page.id,
      source: "checkout_page",
      currency,
      lineItems,
      stripeCheckoutSessionId: session.id,
      livemode: session.livemode,
      buyerEmail: email || null,
      buyerName: name || null,
      attribution,
      deliveries: deliverySnapshots([{ ...main, id: page.productId }, ...bumps]),
    });
  } catch (err) {
    // An unrecorded payment is worse than a failed checkout, so refuse.
    console.error(`[co/session] pending order write failed sa=${subAccountId}`, err);
    return fail(
      "Payments are temporarily unavailable. Please try again later.",
      500,
    );
  }

  return NextResponse.json({ url: session.url });
}
