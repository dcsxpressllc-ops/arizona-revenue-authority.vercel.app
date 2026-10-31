"use client";

import { useEffect, useState } from "react";

export type ConversationTheme = "standard" | "native";

const STORAGE_KEY = "ls:conversation-theme";

/**
 * Per-operator thread skin, in localStorage: "standard" (neutral bubbles,
 * default) or "native" (WhatsApp green + ticks, SMS iMessage-blue). Renders
 * "standard" first for SSR, then hydrates from storage.
 */
export function useConversationTheme(): {
  theme: ConversationTheme;
  setTheme: (t: ConversationTheme) => void;
} {
  const [theme, setThemeState] = useState<ConversationTheme>("standard");

  useEffect(() => {
    try {
      const v = window.localStorage.getItem(STORAGE_KEY);
      if (v === "native" || v === "standard") setThemeState(v);
    } catch {
      // private mode / storage disabled
    }
  }, []);

  const setTheme = (t: ConversationTheme) => {
    setThemeState(t);
    try {
      window.localStorage.setItem(STORAGE_KEY, t);
    } catch {
      // ignore
    }
  };

  return { theme, setTheme };
}
