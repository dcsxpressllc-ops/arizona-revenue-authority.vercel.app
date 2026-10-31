"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { LANDING_VARIANT } from "@/config/landing";

/**
 * "leadstack" mode only: adds the manifest, apple-touch-icon and iOS standalone
 * metas on auth surfaces (sign-in/up, dashboard). Installability is judged per page,
 * so the sales pages carry no PWA surface while a signed-in operator can still
 * install. No-op in "custom" mode, where root-layout metadata declares the manifest.
 */

const AUTH_SURFACE_PREFIXES = [
  "/login",
  "/signup",
  "/sa/",
  "/agency",
  "/me/",
  "/dashboard",
  "/contacts",
  "/pipeline",
  "/calendar",
  "/tasks",
  "/forms",
  "/reports",
  "/conversations",
];

function isAuthSurface(pathname: string): boolean {
  return AUTH_SURFACE_PREFIXES.some(
    (p) => pathname === p.replace(/\/$/, "") || pathname.startsWith(p),
  );
}

export function PwaLinks() {
  const pathname = usePathname();
  const active = LANDING_VARIANT !== "custom" && isAuthSurface(pathname ?? "");

  useEffect(() => {
    if (!active) return;
    const els: HTMLElement[] = [];
    const add = (tag: "link" | "meta", attrs: Record<string, string>) => {
      const el = document.createElement(tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      document.head.appendChild(el);
      els.push(el);
    };
    add("link", { rel: "manifest", href: "/manifest.webmanifest" });
    // Serving route, so an uploaded icon applies; 302s to the chevron default otherwise.
    add("link", { rel: "apple-touch-icon", href: "/api/pwa/icon/apple" });
    add("meta", { name: "apple-mobile-web-app-capable", content: "yes" });
    add("meta", { name: "apple-mobile-web-app-title", content: "LeadStack" });
    return () => {
      for (const el of els) el.remove();
    };
  }, [active]);

  return null;
}
