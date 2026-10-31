"use client";

import { useEffect, useMemo, useState } from "react";
import { ShoppingBag } from "lucide-react";

import { Checkbox } from "@/components/ui/checkbox";
import { Section, TILE_OFF, TILE_ON } from "@/components/website/website-form-parts";
import { subscribeToProducts } from "@/lib/firestore/products";
import { isSellableProduct, sellOnlineReady } from "@/lib/products/sell-online";
import type { Product } from "@/types/products";
import type { SubAccountDoc } from "@/types/tenancy";

/**
 * Which "Sell online" products the site shows on its Shop pages. Renders
 * nothing unless the workspace can sell and has at least one sellable
 * product, so the wizard is unchanged everywhere else.
 * `value` null/undefined = all sellable products.
 */
export function WebsiteProductsPicker({
  subAccountId,
  subAccount,
  value,
  onChange,
}: {
  subAccountId: string;
  subAccount: SubAccountDoc | null;
  value: string[] | null | undefined;
  onChange: (next: string[] | null) => void;
}) {
  const ready = sellOnlineReady(subAccount);
  const agencyId = subAccount?.agencyId ?? null;
  const [products, setProducts] = useState<Product[]>([]);

  useEffect(() => {
    if (!ready || !agencyId) return;
    return subscribeToProducts({ agencyId, subAccountId }, setProducts, () => setProducts([]));
  }, [ready, agencyId, subAccountId]);

  const sellable = useMemo(
    () => products.filter((p) => isSellableProduct(p) && p.unitPriceCents > 0),
    [products],
  );
  if (!ready || sellable.length === 0) return null;

  const selected = new Set(Array.isArray(value) ? value : sellable.map((p) => p.id));
  const toggle = (id: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    // Everything ticked collapses back to "all", so products added later show up too.
    onChange(sellable.every((p) => next.has(p.id)) ? null : sellable.filter((p) => next.has(p.id)).map((p) => p.id));
  };

  const overCap = selected.size > MAX_SITE_PRODUCTS;
  return (
    <Section title="Products on the site" description="Sell your products straight from the website.">
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        The site gets a Shop page and a page for each ticked product, with Buy
        buttons that take payment through your Stripe. Products marked
        &ldquo;Sell online&rdquo; under Products appear here.
      </p>
      {overCap && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          A site shows up to {MAX_SITE_PRODUCTS} products; untick some, or
          only the first {MAX_SITE_PRODUCTS} alphabetically are used.
        </p>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        {sellable.map((p) => {
          const on = selected.has(p.id);
          const img = p.images?.[0];
          return (
            <label
              key={p.id}
              className={`${on ? TILE_ON : TILE_OFF} flex cursor-pointer items-center gap-3 rounded-xl border p-3 transition-colors`}
            >
              <Checkbox checked={on} onCheckedChange={(c) => toggle(p.id, c === true)} />
              {img ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={img.url} alt="" className="h-9 w-9 shrink-0 rounded-md object-cover" />
              ) : (
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted">
                  <ShoppingBag className="h-4 w-4 text-muted-foreground" />
                </span>
              )}
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{p.name}</span>
                <span className="block text-xs text-muted-foreground">
                  {formatPrice(p.unitPriceCents, p.currency)}
                  {!img && " · no image yet"}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </div>
    </Section>
  );
}

/** Mirrors the server cap (products-catalog-service). */
const MAX_SITE_PRODUCTS = 24;

function formatPrice(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: currency || "USD" }).format(
      cents / 100,
    );
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}
