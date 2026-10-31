"use client";

import { useEffect } from "react";
import { useAgency } from "@/hooks/use-agency";
import { LANDING_VARIANT } from "@/config/landing";
import type { AppTheme } from "@/types";

/**
 * Applies the agency accent theme by toggling a class on <html>, so portalled UI
 * (dialogs, sheets, toasts at <body>) picks up the CSS variables too. Unset = the
 * deployment default: "custom" buyers get the green palette, the LeadStack demo
 * stays neutral. "neutral" removes both classes (stock zinc). The class is removed
 * on unmount so public pages don't inherit the accent.
 */

const THEME_CLASSES: Record<Exclude<AppTheme, "neutral">, string> = {
  green: "theme-green",
  leadstack: "theme-leadstack",
};

export function AppAccent() {
  const { appTheme } = useAgency();

  useEffect(() => {
    const resolved: AppTheme =
      appTheme ?? (LANDING_VARIANT === "custom" ? "green" : "neutral");
    const el = document.documentElement;
    el.classList.remove("theme-green", "theme-leadstack");
    if (resolved !== "neutral") el.classList.add(THEME_CLASSES[resolved]);
    return () => {
      el.classList.remove("theme-green", "theme-leadstack");
    };
  }, [appTheme]);

  return null;
}
