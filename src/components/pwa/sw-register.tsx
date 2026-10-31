"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

/**
 * Registers the push-only service worker (public/sw.js). Skips /embed/* so the
 * chat widget iframe never registers a worker for the host page's visitors.
 * Idempotent, fails silently; only install and push need it.
 */
export function SwRegister() {
  const pathname = usePathname();
  const isEmbed = pathname?.startsWith("/embed");

  useEffect(() => {
    if (isEmbed) return;
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker
      .register("/sw.js")
      .catch((err) => console.warn("[pwa] service worker registration failed", err));
  }, [isEmbed]);

  return null;
}
