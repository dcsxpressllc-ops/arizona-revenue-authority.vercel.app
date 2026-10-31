"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpFromDot, Download, X } from "lucide-react";

/**
 * Mobile install prompt, shown once and dismissible (localStorage). Mounted only in
 * the dashboard layout, so public pages never see it. Hidden when already
 * standalone. Chromium uses the captured `beforeinstallprompt`; iOS Safari has no
 * install event, so it shows Share > Add to Home Screen instructions (also the
 * gate to iOS push, hence the lead-alert copy). Phone-only via md:hidden.
 */

const DISMISS_KEY = "leadstack-install-banner-dismissed";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export function InstallBanner() {
  const [mode, setMode] = useState<"hidden" | "android" | "ios">("hidden");
  const [installEvent, setInstallEvent] =
    useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (localStorage.getItem(DISMISS_KEY)) return;
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as unknown as { standalone?: boolean }).standalone === true;
    if (standalone) return;

    const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent);
    if (isIos) {
      setMode("ios");
      return;
    }

    // Chromium only fires this when the app is installable and not installed.
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setInstallEvent(e as BeforeInstallPromptEvent);
      setMode("android");
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  if (mode === "hidden") return null;

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, "1");
    setMode("hidden");
  };

  const install = async () => {
    if (!installEvent) return;
    await installEvent.prompt();
    const choice = await installEvent.userChoice;
    if (choice.outcome === "accepted") setMode("hidden");
  };

  return (
    <div className="border-b bg-card px-4 py-2.5 md:hidden">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
          {mode === "android" ? (
            <Download className="h-3.5 w-3.5" />
          ) : (
            <ArrowUpFromDot className="h-3.5 w-3.5" />
          )}
        </span>
        <div className="min-w-0 flex-1 text-xs">
          {mode === "android" ? (
            <>
              <p className="font-medium">Install the app</p>
              <p className="mt-0.5 text-muted-foreground">
                Get lead alerts on your phone the moment they come in.{" "}
                <button
                  onClick={() => void install()}
                  className="font-medium text-indigo-600 underline-offset-2 hover:underline dark:text-indigo-400"
                >
                  Install now
                </button>
              </p>
            </>
          ) : (
            <>
              <p className="font-medium">Add to your home screen</p>
              <p className="mt-0.5 text-muted-foreground">
                Lead alerts on iPhone need the installed app: tap Safari&apos;s{" "}
                <span className="font-medium">Share</span> button, then{" "}
                <span className="font-medium">Add to Home Screen</span>. Then
                turn on alerts in{" "}
                <Link
                  href="/me/settings"
                  className="font-medium text-indigo-600 underline-offset-2 hover:underline dark:text-indigo-400"
                >
                  your settings
                </Link>
                .
              </p>
            </>
          )}
        </div>
        <button
          onClick={dismiss}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
