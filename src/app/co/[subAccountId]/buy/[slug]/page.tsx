import type { Metadata } from "next";
import { redirect } from "next/navigation";

import CheckoutThanksPage from "@/app/co/[subAccountId]/[slug]/thanks/page";
import { BuyButton } from "@/components/buy/buy-button";
import { BuyShell, LockLine, formatMoney } from "@/components/buy/buy-shell";
import {
  loadBuyBrand,
  loadBuyContext,
  sanitizeWebsiteRef,
  websiteReturnUrl,
} from "@/lib/server/product-buy-service";

export const dynamic = "force-dynamic";

/**
 * Express buy link for one product. Server-rendered and tiny on purpose: the
 * only client code is the button that creates the Stripe session. Anything
 * not for sale gets a friendly page rather than a bare 404.
 */

type Params = Promise<{ subAccountId: string; slug: string }>;
type Search = Promise<Record<string, string | string[] | undefined>>;

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { subAccountId, slug } = await params;
  const buy = await loadBuyContext(subAccountId, slug);
  return {
    title: buy ? `${buy.product.name} | ${buy.brand.name}` : "Checkout",
    robots: { index: false, follow: false },
  };
}

export default async function ExpressBuyPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Search;
}) {
  const { subAccountId, slug } = await params;
  // A checkout page created before "buy" was reserved still sends buyers to
  // /co/[id]/buy/thanks, which this route now matches. Product slugs can't be
  // "thanks", so hand it back to that page's thank-you screen.
  if (slug === "thanks") {
    return CheckoutThanksPage({
      params: Promise.resolve({ subAccountId, slug: "buy" }),
    });
  }
  const sp = await searchParams;
  const websiteRef = sanitizeWebsiteRef({ siteId: one(sp.site), page: one(sp.page) });

  const buy = await loadBuyContext(subAccountId, slug);
  if (buy?.checkoutPageSlug) redirect(`/co/${subAccountId}/${buy.checkoutPageSlug}`);

  const back = await websiteReturnUrl(subAccountId, websiteRef);

  if (!buy) {
    const brand = await loadBuyBrand(subAccountId);
    return (
      <BuyShell brand={brand} back={back}>
        <div className="rounded-2xl border border-zinc-200 bg-white p-8 text-center shadow-sm">
          <h1 className="text-xl font-semibold">This item isn&apos;t available right now</h1>
          <p className="mt-2 text-sm leading-relaxed text-zinc-600">
            It may have sold out or been updated. Nothing has been charged.
          </p>
        </div>
      </BuyShell>
    );
  }

  const { product, brand } = buy;
  const image = product.images?.[0] ?? null;
  const summary = (product.publicDescription || product.description || "").trim();
  const delivery = product.delivery?.type ?? "none";
  const youGet =
    delivery === "download"
      ? "Instant download right after payment"
      : delivery === "community"
        ? "Access details follow after payment"
        : null;
  const cancelled = one(sp.cancelled) === "1";

  return (
    <BuyShell brand={brand} back={back}>
      {cancelled && (
        <p className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-center text-sm text-amber-800">
          Payment cancelled. You haven&apos;t been charged.
        </p>
      )}
      <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm">
        {image && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={image.url}
            alt={image.alt || product.name}
            width={image.width ?? undefined}
            height={image.height ?? undefined}
            className="aspect-[4/3] w-full object-cover"
          />
        )}
        <div className="p-6 sm:p-8">
          <h1 className="text-2xl font-semibold leading-tight tracking-tight">{product.name}</h1>
          <p className="mt-2 text-3xl font-bold tabular-nums" style={{ color: brand.accent }}>
            {formatMoney(product.unitPriceCents, product.currency || "USD")}
          </p>
          {summary && (
            <p className="mt-4 line-clamp-5 whitespace-pre-line text-[15px] leading-relaxed text-zinc-600">
              {summary}
            </p>
          )}
          {youGet && (
            <p className="mt-4 flex items-center gap-2 text-sm font-medium text-zinc-700">
              <span aria-hidden style={{ color: brand.accent }}>✓</span>
              {youGet}
            </p>
          )}
          <div className="mt-6">
            <BuyButton
              subAccountId={subAccountId}
              slug={slug}
              websiteRef={websiteRef}
              accent={brand.accent}
              label="Continue to payment"
            />
            <LockLine />
          </div>
        </div>
      </div>
    </BuyShell>
  );
}
