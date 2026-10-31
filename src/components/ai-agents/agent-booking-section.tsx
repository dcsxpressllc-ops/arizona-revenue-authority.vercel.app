"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { CalendarCheck, Loader2 } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { subscribeToBookingPages } from "@/lib/firestore/booking-pages";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import type { AiAgentProfile } from "@/types/ai";
import type { BookingPage } from "@/types/booking";

/**
 * Overview card for booking settings shared across channels: the booking
 * page the AI books on over SMS, WhatsApp and Messenger/Instagram, and the
 * switch to ask the booking page's questions before booking (every channel).
 */
export function AgentBookingSection() {
  const { subAccountId, isAdmin } = useSubAccount();
  const [loaded, setLoaded] = useState(false);
  // A failed load must not show "Off": saving that would clear the real setting.
  const [loadFailed, setLoadFailed] = useState(false);
  const [saved, setSaved] = useState<{ slug: string; askIntake: boolean }>({
    slug: "",
    askIntake: false,
  });
  const [slug, setSlug] = useState("");
  const [askIntake, setAskIntake] = useState(false);
  const [pages, setPages] = useState<BookingPage[]>([]);
  const [pagesLoaded, setPagesLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/sub-accounts/${subAccountId}/ai-agent/profile`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { profile: AiAgentProfile | null };
        if (cancelled) return;
        const s = data.profile?.messagingBookingPageSlug ?? "";
        const a = data.profile?.bookingAskIntake === true;
        setSaved({ slug: s, askIntake: a });
        setSlug(s);
        setAskIntake(a);
      } catch {
        if (!cancelled) setLoadFailed(true);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAdmin, subAccountId]);

  // Live so a page published in another tab shows up without a refresh.
  useEffect(() => {
    if (!isAdmin || !subAccountId) return;
    const unsub = subscribeToBookingPages(
      subAccountId,
      (next) => {
        setPages(next);
        setPagesLoaded(true);
      },
      () => setPagesLoaded(true),
    );
    return () => unsub();
  }, [isAdmin, subAccountId]);

  const bookablePages = useMemo(
    () => pages.filter((p) => p.status === "published" && !p.payment),
    [pages],
  );
  const savedPageMissing = !!slug && !bookablePages.some((p) => p.slug === slug);
  const dirty = slug !== saved.slug || askIntake !== saved.askIntake;

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/ai-agent/profile`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messagingBookingPageSlug: slug || null,
          bookingAskIntake: askIntake,
        }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        toast.error(data.error ?? "Couldn't save booking settings");
        return;
      }
      setSaved({ slug, askIntake });
      toast.success("Booking settings saved");
    } catch {
      toast.error("Network error — try again");
    } finally {
      setSaving(false);
    }
  }

  if (!isAdmin) return null;

  return (
    <section className="rounded-2xl border bg-card p-6">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-400">
          <CalendarCheck className="h-4 w-4" />
        </span>
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold">
            Live booking
            <span className="rounded-full bg-fuchsia-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-fuchsia-600 dark:text-fuchsia-400">
              Beta
            </span>
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Let the agent book, move and cancel appointments inside the
            conversation. Web Chat and Voice pick their own booking page on their
            channel pages; messages over SMS, WhatsApp and Messenger/Instagram use
            the page below.
          </p>
        </div>
      </div>

      {!loaded ? (
        <p className="mt-6 text-sm text-muted-foreground">Loading…</p>
      ) : loadFailed ? (
        <p className="mt-6 text-sm text-muted-foreground">
          Couldn&apos;t load the booking settings. Refresh the page to try again.
        </p>
      ) : (
        <form className="mt-6 space-y-5" onSubmit={handleSave}>
          <div className="space-y-1.5">
            <Label htmlFor="ai-messaging-booking-page">
              Booking page for SMS, WhatsApp and Messenger/Instagram
            </Label>
            <select
              id="ai-messaging-booking-page"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              className="flex h-9 w-full rounded-lg border border-input bg-background px-2.5 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 [&_option]:bg-background [&_option]:text-foreground"
            >
              <option value="">Off — the agent shares your booking link instead</option>
              {savedPageMissing && (
                <option value={slug}>
                  {!pagesLoaded
                    ? "Loading…"
                    : (pages.find((p) => p.slug === slug)?.name ?? "Deleted booking page") +
                      " (not bookable — pick another)"}
                </option>
              )}
              {bookablePages.map((p) => (
                <option key={p.slug} value={p.slug}>
                  Book on: {p.name} ({p.durationMinutes} min)
                </option>
              ))}
            </select>
            <p className="text-[11px] text-muted-foreground">
              Published pages without a deposit only. The agent offers up to three
              times from the next 7 days, books in the conversation and sends the
              page&apos;s normal confirmation and reminders. With a page set,
              customers who text in can also move or cancel any of their upcoming
              booking-page appointments. Off = no booking or changes over
              messages. Bookings only happen while the conversation&apos;s AI is
              in auto mode.
            </p>
            {pagesLoaded && savedPageMissing && (
              <p className="text-[11px] text-amber-700 dark:text-amber-400">
                This page can&apos;t be booked right now, so the agent shares your
                booking link instead.
              </p>
            )}
            {pagesLoaded && bookablePages.length === 0 && (
              <p className="text-[11px] text-muted-foreground">
                No published booking pages yet.{" "}
                <Link
                  href={`/sa/${subAccountId}/booking`}
                  className="underline-offset-2 hover:underline"
                >
                  Create one
                </Link>
                .
              </p>
            )}
          </div>

          <div className="flex items-start gap-3 rounded-lg border p-4">
            <Checkbox
              id="ai-booking-intake"
              checked={askIntake}
              onCheckedChange={(v) => setAskIntake(!!v)}
            />
            <div className="flex-1">
              <Label htmlFor="ai-booking-intake" className="text-sm font-medium">
                Ask the booking page&apos;s questions before booking
              </Label>
              <p className="mt-1 text-[12px] text-muted-foreground">
                On every channel (phone, website chat and voice, SMS, WhatsApp,
                Messenger/Instagram) the agent asks the page&apos;s intake
                questions before booking, required ones always and optional ones
                when they fit. Answers are saved on the appointment, like a
                booking made on the page. Off = the agent books with just the
                contact details.
              </p>
            </div>
          </div>

          <div className="flex justify-end">
            <Button type="submit" disabled={saving || !dirty}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save booking settings"}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
