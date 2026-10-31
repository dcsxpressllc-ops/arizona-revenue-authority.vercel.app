"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Link2 } from "lucide-react";
import { toast } from "sonner";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { BookingPage } from "@/types/booking";

// House native-select pattern: explicit bg + text on select and options for dark mode.
const NATIVE_SELECT_CLASSES =
  "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm text-foreground shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring [&_option]:bg-background [&_option]:text-foreground";

const CUSTOM_KEY = "custom";
const NONE_KEY = "";

/**
 * Sets subAccountDoc.bookingLink, the URL behind {{bookingLink}} and the link
 * AI agents share. Without it the tag resolves to "". Pick a published booking
 * page (tracked by slug), a custom URL, or nothing. Saves through the
 * sub-account PATCH route, which validates the URL. Admin-only.
 */
export function DefaultBookingLinkCard({ pages }: { pages: BookingPage[] }) {
  const { subAccountId, subAccount, isAdmin } = useSubAccount();

  const [selection, setSelection] = useState<string>(NONE_KEY);
  const [customUrl, setCustomUrl] = useState("");
  const [saving, setSaving] = useState(false);

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
  const published = pages.filter((p) => p.status === "published");

  function urlForSlug(slug: string): string {
    return `${appUrl}/b/${subAccountId}/${slug}`;
  }

  // A URL matching a published page selects that page; anything else is custom.
  useEffect(() => {
    const stored = subAccount?.bookingLink ?? "";
    if (!stored) {
      setSelection(NONE_KEY);
      setCustomUrl("");
      return;
    }
    const match = published.find((p) => urlForSlug(p.slug) === stored);
    if (match) {
      setSelection(`page:${match.slug}`);
      setCustomUrl("");
    } else {
      setSelection(CUSTOM_KEY);
      setCustomUrl(stored);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hydrate on stored value / page list changes only
  }, [subAccount?.bookingLink, pages]);

  if (!isAdmin) return null;

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    let bookingLink: string | null;
    if (selection === NONE_KEY) {
      bookingLink = null;
    } else if (selection === CUSTOM_KEY) {
      bookingLink = customUrl.trim();
      if (!bookingLink) {
        toast.error("Paste a URL, or pick a booking page.");
        return;
      }
    } else {
      bookingLink = urlForSlug(selection.slice("page:".length));
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/agency/sub-accounts/${subAccountId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookingLink }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? "Could not save.");
      toast.success(
        bookingLink ? "Default booking link saved." : "Default booking link cleared.",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-2xl border bg-card p-5">
      <div className="mb-4 flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal-500/10 text-teal-600 dark:text-teal-400">
          <Link2 className="h-4 w-4" />
        </span>
        <div>
          <h2 className="text-sm font-semibold">Default booking link</h2>
          <p className="text-xs text-muted-foreground">
            Powers the{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-[10px]">
              {"{{bookingLink}}"}
            </code>{" "}
            merge tag and the link your AI agents share when someone wants to
            book.
          </p>
        </div>
      </div>

      <form onSubmit={handleSave} className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="default-booking-link">Link source</Label>
          <select
            id="default-booking-link"
            value={selection}
            onChange={(e) => setSelection(e.target.value)}
            className={NATIVE_SELECT_CLASSES}
          >
            <option value={NONE_KEY}>
              Not set — the merge tag resolves to nothing
            </option>
            {published.map((p) => (
              <option key={p.slug} value={`page:${p.slug}`}>
                Booking page — {p.name}
              </option>
            ))}
            <option value={CUSTOM_KEY}>
              Custom URL (Calendly, Cal.com, anything else)…
            </option>
          </select>
        </div>

        {selection === CUSTOM_KEY && (
          <div className="space-y-1.5">
            <Label htmlFor="default-booking-url">Custom URL</Label>
            <Input
              id="default-booking-url"
              value={customUrl}
              onChange={(e) => setCustomUrl(e.target.value)}
              placeholder="https://calendly.com/your-team/intro-call"
            />
          </div>
        )}

        {selection !== NONE_KEY && selection !== CUSTOM_KEY && (
          <p className="truncate font-mono text-[11px] text-muted-foreground">
            {urlForSlug(selection.slice("page:".length))}
          </p>
        )}

        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </section>
  );
}
