import type { ReactNode } from "react";

import type { BuyBrand } from "@/lib/server/product-buy-service";

/**
 * Chrome for the express buy and thanks pages: the client's logo/name and
 * accent, fixed light colours so the dashboard theme never bleeds into a
 * buyer-facing page.
 */
export function BuyShell({
  brand,
  back,
  children,
}: {
  brand: BuyBrand;
  back: { url: string; host: string } | null;
  children: ReactNode;
}) {
  return (
    <div
      className="flex min-h-screen flex-col bg-zinc-50 text-zinc-900"
      style={{ fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" }}
    >
      <header className="flex justify-center px-4 pb-2 pt-8">
        {brand.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={brand.logoUrl} alt={brand.name} className="h-10 max-w-[200px] object-contain" />
        ) : (
          <span className="text-lg font-semibold tracking-tight">{brand.name}</span>
        )}
      </header>
      <main className="flex flex-1 items-start justify-center px-4 py-6 sm:items-center">
        <div className="w-full max-w-md">{children}</div>
      </main>
      <footer className="px-4 pb-8 text-center text-sm text-zinc-500">
        {back && (
          <a href={back.url} className="underline-offset-4 hover:underline">
            ← Back to {back.host}
          </a>
        )}
      </footer>
    </div>
  );
}

export function formatMoney(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

export function LockLine() {
  return (
    <p className="mt-3 flex items-center justify-center gap-1.5 text-xs text-zinc-500">
      <svg aria-hidden viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="4" y="11" width="16" height="10" rx="2" />
        <path d="M8 11V7a4 4 0 1 1 8 0v4" />
      </svg>
      Payments processed securely by Stripe
    </p>
  );
}
/** White text unless the brand colour is too light for it (WCAG luminance). */
export function readableTextOn(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "#ffffff";
  const n = parseInt(m[1], 16);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const l = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  // Contrast with white beats contrast with near-black below ~0.18 luminance.
  return l > 0.18 ? "#18181b" : "#ffffff";
}
