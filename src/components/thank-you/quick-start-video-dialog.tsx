"use client";

import { useState } from "react";
import { ExternalLink, Map, PlayCircle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// Quick Start Guide Vimeo embed. title/byline/portrait=0 trims the player chrome.
// The iframe only mounts while the dialog is open, so it lazy-loads and stops on close.
const VIMEO_EMBED =
  "https://player.vimeo.com/video/1196531347?title=0&byline=0&portrait=0";

/**
 * "Watch the Quick Start Guide" pill. `defaultOpen` lets a deep link
 * (/thank-you?guide=1 from the invite email) open the modal straight away.
 */
export function QuickStartVideoDialog({
  defaultOpen = false,
}: {
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-sm font-semibold text-emerald-700 transition-colors hover:bg-emerald-500/20 dark:text-emerald-400"
      >
        <PlayCircle className="h-4 w-4" />
        Watch the Quick Start Guide
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Quick Start Guide</DialogTitle>
            <DialogDescription>
              A short walkthrough to get you up and running.
            </DialogDescription>
          </DialogHeader>
          <div className="relative aspect-video w-full overflow-hidden rounded-lg border bg-black">
            {open && (
              <iframe
                src={VIMEO_EMBED}
                title="Quick Start Guide"
                className="absolute inset-0 h-full w-full"
                allow="autoplay; fullscreen; picture-in-picture; clipboard-write"
                allowFullScreen
              />
            )}
          </div>
          <a
            href="/docs/architecture"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 flex items-center justify-between gap-3 rounded-lg border bg-muted/30 px-4 py-3 text-sm transition-colors hover:bg-muted/60"
          >
            <span className="flex items-center gap-2">
              <Map className="h-4 w-4 text-violet-600 dark:text-violet-400" />
              <span>
                <strong className="font-semibold">See the whole platform</strong>{" "}
                <span className="text-muted-foreground">
                  · one-page tube-map view of every feature
                </span>
              </span>
            </span>
            <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
          </a>
        </DialogContent>
      </Dialog>
    </>
  );
}
