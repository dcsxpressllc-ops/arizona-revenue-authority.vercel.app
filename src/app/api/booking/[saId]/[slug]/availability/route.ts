import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  computeAvailability,
  computeRescheduleAvailability,
  computeUnionAvailability,
  type BusyEventWithHost,
  type SlotCandidate,
} from "@/lib/booking/availability";
import { verifyEventToken } from "@/lib/booking/event-token";
import { fetchExternalBusy } from "@/lib/booking/external-busy";
import { eventStatus, eventOccupiesSlot, isImportedEvent } from "@/types/events";
import type { BookingPage } from "@/types/booking";
import type { CalendarEvent } from "@/types/events";

/**
 * Public availability for a booking page (`?from=ISO&to=ISO`). Only published
 * pages return slots, plus a soft per-IP rate limit. Admin SDK reads so rules
 * stay member-scoped; the math is in lib/booking/availability.ts.
 */

// Soft per-IP rate limit, in-memory LRU (per instance).
const HOURLY_CAP = 120; // ~2/min ought to be plenty for legit visitors
const WINDOW_MS = 60 * 60_000;
const ipHits = new Map<string, number[]>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  const arr = (ipHits.get(ip) ?? []).filter((t) => t >= cutoff);
  if (arr.length >= HOURLY_CAP) {
    ipHits.set(ip, arr);
    return true;
  }
  arr.push(now);
  ipHits.set(ip, arr);
  if (ipHits.size > 5000) {
    const oldest = ipHits.keys().next().value;
    if (oldest !== undefined) ipHits.delete(oldest);
  }
  return false;
}

function getClientIp(request: Request): string {
  // Sentinel fallback so envs without x-forwarded-for still rate-limit.
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ saId: string; slug: string }> },
) {
  const { saId, slug } = await ctx.params;

  if (isRateLimited(getClientIp(request))) {
    return NextResponse.json(
      { error: "Too many requests. Try again in a minute." },
      { status: 429 },
    );
  }

  const db = getAdminDb();
  const pageSnap = await db
    .doc(`subAccounts/${saId}/bookingPages/${slug}`)
    .get();
  // Missing and draft look the same so unpublished pages don't leak.
  if (!pageSnap.exists) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const page = pageSnap.data() as BookingPage;
  if (page.status !== "published") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // All optional; computeAvailability defaults to now..now+visibleDays.
  // `excludeEventId` lets a rescheduling attendee see their own slot as free.
  const url = new URL(request.url);
  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");
  let excludeEventId = url.searchParams.get("excludeEventId");
  // A reschedule from the attendee page sends its token instead, so the times
  // match the reschedule check (a team booking keeps its host).
  let reschedule: { assignedToUid: string | null } | null = null;
  const rescheduleToken = url.searchParams.get("rescheduleToken");
  if (rescheduleToken) {
    const verified = verifyEventToken(rescheduleToken);
    const eventSnap = verified
      ? await db.collection("events").doc(verified.eventId).get()
      : null;
    const ev = eventSnap?.exists ? (eventSnap.data() as CalendarEvent) : null;
    if (
      !verified ||
      !ev ||
      ev.subAccountId !== saId ||
      ev.bookingPageSlug !== slug ||
      ev.publicTokenHash !== verified.hash
    ) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    excludeEventId = verified.eventId;
    reschedule = { assignedToUid: ev.assignedToUid ?? null };
  }
  const now = new Date();
  const fromInstant = fromParam ? new Date(fromParam) : undefined;
  const toInstant = toParam ? new Date(toParam) : undefined;
  if (fromInstant && Number.isNaN(fromInstant.getTime())) {
    return NextResponse.json(
      { error: "Invalid `from` query param." },
      { status: 400 },
    );
  }
  if (toInstant && Number.isNaN(toInstant.getTime())) {
    return NextResponse.json(
      { error: "Invalid `to` query param." },
      { status: 400 },
    );
  }

  // Busy events for the window, via the events(subAccountId, startAt)
  // composite index. Widened so events starting before `fromInstant` count.
  const horizonEnd =
    toInstant ?? new Date(now.getTime() + page.visibleDays * 24 * 60 * 60_000);
  // Look back 8h (longer than any booking) to catch events still running.
  const lookbackMs = 8 * 60 * 60_000;
  const queryFrom = new Date(
    (fromInstant ?? now).getTime() - lookbackMs,
  );

  // Host tag only matters in team mode.
  const busy: BusyEventWithHost[] = [];
  try {
    const eventsSnap = await db
      .collection("events")
      .where("subAccountId", "==", saId)
      .where("startAt", ">=", queryFrom)
      .where("startAt", "<=", horizonEnd)
      .get();

    for (const d of eventsSnap.docs) {
      // Skip the rescheduling event so its current slot shows as available.
      if (excludeEventId && d.id === excludeEventId) continue;
      const e = d.data() as CalendarEvent;
      // Imported Google events: free/busy already covers them, and they never
      // count as bookings or leave the CRM.
      if (isImportedEvent(e)) continue;
      if (!eventOccupiesSlot(eventStatus(e))) continue;
      // Skip malformed timestamps so one bad event can't kill the response.
      const startAt = (e.startAt as { toDate?: () => Date } | null)?.toDate?.();
      const endAt = (e.endAt as { toDate?: () => Date } | null)?.toDate?.();
      if (!(startAt instanceof Date) || !(endAt instanceof Date)) continue;
      busy.push({ startAt, endAt, assignedToUid: e.assignedToUid ?? null });
    }
  } catch (err) {
    // Usually a missing composite index (FAILED_PRECONDITION with a create
    // link). Logged with saId + slug so it's greppable.
    const message = err instanceof Error ? err.message : "unknown";
    console.error(
      `[booking/availability] events query failed sa=${saId} slug=${slug}: ${message}`,
      err,
    );
    return NextResponse.json(
      {
        error: "availability_query_failed",
        message:
          "Couldn't load availability. The deployment may be missing a Firestore index; ask the agency operator to deploy indexes (`firebase deploy --only firestore:indexes`).",
      },
      { status: 500 },
    );
  }

  const hosts = page.hosts ?? [];
  const teamMode = hosts.length > 0;

  // Connected members' Google busy blocks merge in as extra busy rows. Team
  // mode only reads the page's hosts; single mode reads everyone connected.
  // Fail-open: a Google outage just leaves internal-only availability.
  busy.push(
    ...(await fetchExternalBusy(
      saId,
      { from: queryFrom, to: horizonEnd },
      // A reschedule reads the same calendars as its re-check does.
      reschedule
        ? reschedule.assignedToUid
          ? { onlyUids: [reschedule.assignedToUid] }
          : {}
        : teamMode
          ? { onlyUids: hosts.map((h) => h.uid) }
          : {},
    )),
  );
  // Host names and narrowing only on pages opted into named selection, so a
  // forged `host` param can't leak staff names elsewhere.
  const allowHostSelection = teamMode && page.allowHostSelection === true;
  const hostParam = url.searchParams.get("host");
  const selectedHostUid =
    allowHostSelection && hostParam && hosts.some((h) => h.uid === hostParam)
      ? hostParam
      : null;

  let slots: SlotCandidate[];
  try {
    slots = reschedule
      ? computeRescheduleAvailability({
          page,
          now,
          fromInstant,
          toInstant,
          busy,
          assignedToUid: reschedule.assignedToUid,
        })
      : teamMode
      ? computeUnionAvailability({
          page,
          now,
          fromInstant,
          toInstant,
          busy,
          hostUids: hosts.map((h) => h.uid),
          onlyHostUid: selectedHostUid,
        })
      : computeAvailability({
          page,
          now,
          fromInstant,
          toInstant,
          // Single mode treats every occupying event as a shared conflict.
          busy: busy.map((b) => ({ startAt: b.startAt, endAt: b.endAt })),
        });
  } catch (err) {
    // Malformed page config (no workingHours, bad timezone) can throw here.
    const message = err instanceof Error ? err.message : "unknown";
    console.error(
      `[booking/availability] compute failed sa=${saId} slug=${slug}: ${message}`,
      err,
    );
    return NextResponse.json(
      {
        error: "availability_compute_failed",
        message:
          "Couldn't compute availability — the booking page config may be malformed (working hours / timezone / duration).",
      },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    slots: slots.map((s) => ({
      startAt: s.startAt.toISOString(),
      endAt: s.endAt.toISOString(),
    })),
    timezone: page.timezone,
    durationMinutes: page.durationMinutes,
    // Roster only on opted-in pages, so pooled pages can't be probed for names.
    ...(allowHostSelection
      ? {
          allowHostSelection: true,
          hosts: hosts.map((h) => ({ uid: h.uid, name: h.name })),
          selectedHostUid,
        }
      : {}),
  });
}
