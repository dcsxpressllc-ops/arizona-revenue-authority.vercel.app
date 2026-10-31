import "server-only";

import { Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  verifyCalendarFeedToken,
  verifyHostCalendarFeedToken,
} from "@/lib/booking/calendar-feed-token";
import {
  generateIcsFeed,
  type FeedEventInput,
} from "@/lib/booking/ics-feed";
import { eventStatus, isImportedEvent } from "@/types/events";
import type { CalendarEvent } from "@/types/events";
import type { SubAccountMemberDoc } from "@/types/tenancy";

/**
 * Public read-only ICS feed: GET /api/sub-accounts/{id}/calendar.ics?t=<token>
 * Auth is the HMAC token (calendar-feed-token.ts); the path is public because
 * Google Calendar's poller has no session.
 *
 * Events from now - 30 days, capped at 500. Cancelled events are included as
 * STATUS:CANCELLED so subscribers drop them on the next poll. 5-min cache
 * absorbs several pollers hitting at once.
 */

const FEED_LOOKBACK_DAYS = 30;
const FEED_EVENT_CAP = 500;

function statusForIcs(
  s: ReturnType<typeof eventStatus>,
): FeedEventInput["status"] {
  if (s === "cancelled") return "CANCELLED";
  if (s === "awaiting_payment") return "TENTATIVE";
  return "CONFIRMED";
}

function tsToDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  const m = v as { toDate?: () => Date };
  if (typeof m.toDate === "function") return m.toDate();
  return null;
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const url = new URL(request.url);
  const token = url.searchParams.get("t") ?? "";
  const host = url.searchParams.get("host");

  const db = getAdminDb();

  // Two feeds: all bookings (no `host`, sub-account token) and per-host
  // (`?host=<uid>`, token bound to subAccountId + uid, plus an active-member
  // check so a removed member's leaked feed goes dead). Always 404, not 401.
  let hostMemberName: string | null = null;
  if (host) {
    if (!verifyHostCalendarFeedToken(subAccountId, host, token)) {
      return new Response("Not found", { status: 404 });
    }
    const memberSnap = await db
      .doc(`subAccounts/${subAccountId}/subAccountMembers/${host}`)
      .get();
    const member = memberSnap.exists
      ? (memberSnap.data() as SubAccountMemberDoc)
      : null;
    if (!member || member.status !== "active") {
      return new Response("Not found", { status: 404 });
    }
    hostMemberName = member.displayName || member.email || null;
  } else if (!verifyCalendarFeedToken(subAccountId, token)) {
    return new Response("Not found", { status: 404 });
  }
  const hostMode = host != null;

  // Only for the display name; falls back to "LeadStack bookings".
  const subSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  const subName = (subSnap.data()?.name as string | undefined) ?? null;
  let calendarName: string;
  if (hostMode) {
    const who = hostMemberName ? `${hostMemberName}'s` : "My";
    calendarName = subName
      ? `${subName} — ${who} bookings`
      : `${who} LeadStack bookings`;
  } else {
    calendarName = subName
      ? `${subName} — LeadStack bookings`
      : "LeadStack bookings";
  }

  const lookback = new Date(Date.now() - FEED_LOOKBACK_DAYS * 24 * 60 * 60_000);
  let q = db
    .collection("events")
    .where("subAccountId", "==", subAccountId);
  if (hostMode && host) {
    // Needs the events(subAccountId, assignedToUid, startAt) index.
    q = q.where("assignedToUid", "==", host);
  }
  q = q
    .where("startAt", ">=", Timestamp.fromDate(lookback))
    .orderBy("startAt", "asc");
  // Paged so imported Google events (skipped below) can't crowd real bookings
  // out of the cap, however many there are.
  const docs: FirebaseFirestore.QueryDocumentSnapshot[] = [];
  try {
    let kept = 0;
    let cursor: FirebaseFirestore.QueryDocumentSnapshot | null = null;
    for (let page = 0; page < 10 && kept < FEED_EVENT_CAP; page++) {
      const pageSnap: FirebaseFirestore.QuerySnapshot = await (cursor
        ? q.startAfter(cursor)
        : q
      )
        .limit(FEED_EVENT_CAP)
        .get();
      for (const d of pageSnap.docs) {
        docs.push(d);
        if (d.get("source") !== "google") kept++;
      }
      if (pageSnap.size < FEED_EVENT_CAP) break;
      cursor = pageSnap.docs[pageSnap.docs.length - 1];
    }
  } catch (err) {
    // Most likely a missing composite index. Greppable log + soft 503 so the
    // poller retries.
    console.error(
      `[calendar.ics] events query failed sa=${subAccountId} host=${host ?? "-"}`,
      err,
    );
    return new Response("Calendar temporarily unavailable", { status: 503 });
  }

  const feedEvents: FeedEventInput[] = [];
  for (const d of docs) {
    if (feedEvents.length >= FEED_EVENT_CAP) break;
    const e = d.data() as CalendarEvent;
    // Imported Google events: free/busy already covers them, and they never
    // count as bookings or leave the CRM.
    if (isImportedEvent(e)) continue;
    const startAt = tsToDate(e.startAt);
    const endAt = tsToDate(e.endAt);
    if (!startAt || !endAt) continue;
    // Only the all-bookings feed names the host.
    const baseSummary = e.title || "Booking";
    const summary =
      !hostMode && e.assignedToName
        ? `${baseSummary} — ${e.assignedToName}`
        : baseSummary;
    feedEvents.push({
      uid: d.id,
      startAt,
      endAt,
      summary,
      description: e.notes || undefined,
      // meetingUrl in LOCATION so Google/Apple detect the join link; otherwise
      // the free-text location.
      location: e.meetingUrl || e.location || undefined,
      status: statusForIcs(eventStatus(e)),
      lastModified: tsToDate(e.updatedAt) ?? undefined,
    });
  }

  const domain = process.env.NEXT_PUBLIC_APP_URL
    ?.replace(/^https?:\/\//, "")
    ?.replace(/\/.*$/, "")
    ?.toLowerCase() ?? "leadstack.dev";

  const ics = generateIcsFeed({
    domain,
    calendarName,
    events: feedEvents,
  });

  return new Response(ics, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      // Google polls every 8-24h anyway; this dedupes concurrent pollers.
      "Cache-Control": "public, max-age=300, s-maxage=300",
      // For clients that download instead of subscribe (Apple File -> Import).
      "Content-Disposition": `inline; filename="calendar.ics"`,
    },
  });
}
