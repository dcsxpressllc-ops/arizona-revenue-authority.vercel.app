import type { Metadata } from "next";
import type Stripe from "stripe";

import { BuyShell, formatMoney, readableTextOn } from "@/components/buy/buy-shell";
import { findOrderByCheckoutSession } from "@/lib/server/orders-service";
import {
  loadBuyBrand,
  sanitizeWebsiteRef,
  websiteReturnUrl,
} from "@/lib/server/product-buy-service";
import { getSubAccountStripe } from "@/lib/stripe/sub-account-client";
import type { Order } from "@/types/orders";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Thank you",
  robots: { index: false, follow: false },
};

type Search = Promise<Record<string, string | string[] | undefined>>;

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Express buy thank-you page. Stripe redirects here before the webhook has
 * marked the order paid, so payment is confirmed by asking Stripe for the
 * session directly. Paid content (a download link) comes only from the
 * order's own delivery snapshot, never from the URL.
 */
async function loadPaidOrder(
  subAccountId: string,
  sessionId: string | undefined,
): Promise<{ order: Order; paid: boolean; email: string | null } | null> {
  if (!sessionId || !/^cs_(test|live)_[A-Za-z0-9]{10,200}$/.test(sessionId)) return null;
  const order = await findOrderByCheckoutSession(sessionId).catch(() => null);
  if (!order || order.subAccountId !== subAccountId || order.source !== "product_link") {
    return null;
  }
  if (order.status === "paid") {
    return { order, paid: true, email: order.buyerEmail };
  }
  // Refunded/failed orders must not show paid content, even though Stripe's
  // session still reports payment_status "paid".
  if (order.status !== "pending") return { order, paid: false, email: null };
  try {
    const ctx = await getSubAccountStripe(subAccountId);
    const session: Stripe.Checkout.Session = ctx.opts
      ? await ctx.stripe.checkout.sessions.retrieve(sessionId, ctx.opts)
      : await ctx.stripe.checkout.sessions.retrieve(sessionId);
    return {
      order,
      paid: session.payment_status === "paid",
      email: session.customer_details?.email ?? null,
    };
  } catch (err) {
    console.warn(`[buy/thanks] session lookup failed sa=${subAccountId}`, err);
    return { order, paid: false, email: null };
  }
}

export default async function ExpressBuyThanksPage({
  params,
  searchParams,
}: {
  params: Promise<{ subAccountId: string; slug: string }>;
  searchParams: Search;
}) {
  const { subAccountId } = await params;
  const sp = await searchParams;
  const [brand, result] = await Promise.all([
    loadBuyBrand(subAccountId),
    loadPaidOrder(subAccountId, one(sp.session_id)),
  ]);
  const websiteRef =
    result?.order.websiteRef ??
    sanitizeWebsiteRef({ siteId: one(sp.site), page: null });
  // Back to the site's home, not the product page they just bought from.
  const back = await websiteReturnUrl(
    subAccountId,
    websiteRef?.siteId ? { siteId: websiteRef.siteId, page: null } : null,
  );

  const order = result?.order ?? null;
  const paid = result?.paid === true;
  const item = order?.lineItems[0] ?? null;
  const delivery = order?.deliveries?.[0]?.delivery ?? null;
  const state: "unknown" | "paid" | "processing" | "closed" = !order
    ? "unknown"
    : paid
      ? "paid"
      : order.status === "pending"
        ? "processing"
        : "closed";

  return (
    <BuyShell brand={brand} back={back}>
      <div className="rounded-2xl border border-zinc-200 bg-white p-8 text-center shadow-sm">
        <div
          aria-hidden
          className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full text-2xl"
          style={{ background: `${brand.accent}1a`, color: brand.accent }}
        >
          {state === "processing" ? "…" : "✓"}
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {state === "processing" ? "Payment processing" : "Thank you!"}
        </h1>

        {state === "unknown" ? (
          <p className="mt-3 text-[15px] leading-relaxed text-zinc-600">
            Thanks for your order. Your confirmation email has all the details.
          </p>
        ) : state === "closed" ? (
          <p className="mt-3 text-[15px] leading-relaxed text-zinc-600">
            This order is no longer active. If that&apos;s unexpected, reply
            to your confirmation email and we&apos;ll help.
          </p>
        ) : state === "processing" ? (
          <p className="mt-3 text-[15px] leading-relaxed text-zinc-600">
            Your payment is being confirmed. You&apos;ll get an email as soon as
            it goes through; there&apos;s no need to pay again.
          </p>
        ) : (
          <p className="mt-3 text-[15px] leading-relaxed text-zinc-600">
            Your payment went through
            {result?.email ? (
              <>
                . A confirmation is on its way to <strong className="text-zinc-800">{result.email}</strong>.
              </>
            ) : (
              ". A confirmation is on its way to your email."
            )}
          </p>
        )}

        {item && order && (
          <div className="mt-6 flex items-center justify-between gap-4 rounded-xl bg-zinc-50 px-4 py-3 text-left text-sm">
            <span className="min-w-0 truncate font-medium">{item.name}</span>
            <span className="shrink-0 tabular-nums text-zinc-700">
              {formatMoney(order.totalCents, order.currency)}
            </span>
          </div>
        )}

        {paid && delivery?.type === "download" && (
          <a
            href={delivery.url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-6 flex h-12 w-full items-center justify-center rounded-xl text-base font-semibold shadow-sm transition hover:brightness-110"
            style={{ background: brand.accent, color: readableTextOn(brand.accent) }}
          >
            {delivery.label || "Download"}
          </a>
        )}

        {paid && (
          <p className="mt-5 text-sm leading-relaxed text-zinc-600">
            {delivery?.type === "download"
              ? "Download it now and keep a copy somewhere safe."
              : delivery?.type === "community"
                ? "Your access is ready. Check your email for a sign-in link; it can take a minute to arrive."
                : "We'll be in touch shortly about next steps."}
          </p>
        )}
      </div>
    </BuyShell>
  );
}
