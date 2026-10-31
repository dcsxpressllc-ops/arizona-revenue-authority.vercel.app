"use client";

import { useEffect, useState } from "react";

import { readableTextOn } from "@/components/buy/buy-shell";
import type { OrderWebsiteRef } from "@/types/orders";

/**
 * Creates the Stripe session on click, never on load: JS-rendering crawlers
 * and link previews would otherwise mint a pending order per visit.
 */
export function BuyButton({
  subAccountId,
  slug,
  websiteRef,
  accent,
  label,
}: {
  subAccountId: string;
  slug: string;
  websiteRef: OrderWebsiteRef | null;
  accent: string;
  label: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Back from Stripe restores this page from the back/forward cache with the
  // button still spinning; reset it.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) setBusy(false);
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  const textColor = readableTextOn(accent);

  async function go() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/co/${subAccountId}/buy/${slug}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ websiteRef }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        url?: string;
        error?: string;
      };
      if (!res.ok || !data.url) {
        throw new Error(data.error ?? "Something went wrong. Please try again.");
      }
      window.location.assign(data.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={go}
        disabled={busy}
        className="flex h-12 w-full items-center justify-center gap-2 rounded-xl text-base font-semibold shadow-sm transition hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-70"
        style={{ background: accent, color: textColor, outlineColor: accent }}
      >
        {busy && (
          <span
            aria-hidden
            className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
          />
        )}
        {busy ? "Opening secure checkout…" : label}
      </button>
      {error && (
        <p role="alert" className="mt-3 text-center text-sm text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
