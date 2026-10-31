import "server-only";

import { NextResponse } from "next/server";
import { FieldValue, Timestamp } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import {
  deleteGoogleBookingCopy,
  pushBookingToGoogle,
} from "@/lib/booking/lifecycle";
import { runAfterResponse } from "@/lib/server/after-response";
import { eventOccupiesSlot, eventSource, eventStatus } from "@/types/events";
import type { CalendarEvent } from "@/types/events";
import type { BookingPage } from "@/types/booking";
import type { SubAccountMemberDoc } from "@/types/tenancy";
import type { ActivityType } from "@/types/contacts";

/**
 * POST { assignedToUid: string | null, force?: boolean }: reassign a booking
 * to another host. Admin or current assignee only. Target must be an active
 * member and, if the page lists hosts, one of them. Overlapping bookings
 * return a soft warning unless `force`. No customer emails; internal only.
 */

interface Body {
  assignedToUid?: string | null;
  force?: boolean;
}

function tsToDate(v: unknown): Date | null {
  const d = (v as { toDate?: () => Date } | null)?.toDate?.();
  return d instanceof Date ? d : null;
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: eventId } = await ctx.params;

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const targetUid =
    typeof body.assignedToUid === "string" && body.assignedToUid.trim()
      ? body.assignedToUid.trim()
      : null;
  const force = body.force === true;

  const db = getAdminDb();
  const eventRef = db.collection("events").doc(eventId);
  const eventSnap = await eventRef.get();
  if (!eventSnap.exists) {
    return NextResponse.json({ error: "Event not found" }, { status: 404 });
  }
  const event = eventSnap.data() as CalendarEvent;

  const access = await requireSubAccountMember(request, event.subAccountId);
  if (access instanceof NextResponse) return access;

  if (eventSource(event) !== "booking_page") {
    return NextResponse.json(
      { error: "Only booking-page events can be reassigned." },
      { status: 400 },
    );
  }

  const isAdmin =
    access.subAccountRole === "admin" ||
    access.subAccountRole === "agencyOwner";
  const isAssignee =
    !!event.assignedToUid && event.assignedToUid === access.uid;
  if (!isAdmin && !isAssignee) {
    return NextResponse.json(
      {
        error: "Only an admin or the current host can reassign this booking.",
      },
      { status: 403 },
    );
  }

  if ((event.assignedToUid ?? null) === targetUid) {
    return NextResponse.json({
      ok: true,
      noop: true,
      assignedToUid: targetUid,
      assignedToName: event.assignedToName ?? null,
    });
  }

  let targetName: string | null = null;

  if (targetUid) {
    if (event.bookingPageSlug) {
      const pageSnap = await db
        .doc(
          `subAccounts/${event.subAccountId}/bookingPages/${event.bookingPageSlug}`,
        )
        .get();
      const page = pageSnap.exists ? (pageSnap.data() as BookingPage) : null;
      const hosts = page?.hosts ?? [];
      if (hosts.length > 0 && !hosts.some((h) => h.uid === targetUid)) {
        return NextResponse.json(
          { error: "That person isn't a host on this booking page." },
          { status: 400 },
        );
      }
    }

    // Active member only; snapshot a fresh display name.
    const memberSnap = await db
      .doc(`subAccounts/${event.subAccountId}/subAccountMembers/${targetUid}`)
      .get();
    const member = memberSnap.exists
      ? (memberSnap.data() as SubAccountMemberDoc)
      : null;
    if (!member || member.status !== "active") {
      return NextResponse.json(
        { error: "That member isn't active on this sub-account." },
        { status: 400 },
      );
    }
    targetName = (member.displayName || member.email || "Host").slice(0, 120);

    // Needs the events(subAccountId, assignedToUid, startAt) composite index.
    const start = tsToDate(event.startAt);
    const end = tsToDate(event.endAt);
    if (!force && start && end) {
      try {
        const lookbackMs = 8 * 60 * 60_000;
        const snap = await db
          .collection("events")
          .where("subAccountId", "==", event.subAccountId)
          .where("assignedToUid", "==", targetUid)
          .where(
            "startAt",
            ">=",
            Timestamp.fromDate(new Date(start.getTime() - lookbackMs)),
          )
          .where("startAt", "<=", Timestamp.fromDate(new Date(end.getTime() + 1000)))
          .get();
        const clash = snap.docs.some((d) => {
          if (d.id === eventId) return false;
          const e = d.data() as CalendarEvent;
          if (!eventOccupiesSlot(eventStatus(e))) return false;
          const s = tsToDate(e.startAt);
          const en = tsToDate(e.endAt);
          if (!s || !en) return false;
          // [s, en) overlaps [start, end)
          return s.getTime() < end.getTime() && en.getTime() > start.getTime();
        });
        if (clash) {
          return NextResponse.json({
            ok: false,
            needsConfirm: true,
            warning: `${targetName} already has a booking that overlaps this time.`,
          });
        }
      } catch (err) {
        // Query failed (e.g. index missing): skip the warning, don't block.
        console.warn(
          `[events/assign] conflict check failed event=${eventId}`,
          err,
        );
      }
    }
  }

  try {
    await eventRef.update({
      assignedToUid: targetUid,
      assignedToName: targetName,
      updatedAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error(`[events/assign] update failed event=${eventId}`, err);
    return NextResponse.json({ error: "Couldn't reassign." }, { status: 500 });
  }

  // Move the Google copy to the new host. The existing join link is kept
  // (no new Meet room) because the customer already has it.
  const startAt = tsToDate(event.startAt);
  const endAt = tsToDate(event.endAt);
  runAfterResponse(async () => {
    await deleteGoogleBookingCopy({ ...event, id: eventId });
    if (!targetUid || !startAt || !endAt) return;
    await pushBookingToGoogle({
      eventId,
      subAccountId: event.subAccountId,
      calendarOwnerUid: targetUid,
      title: event.title || "Meeting",
      description: [
        event.notes?.trim() || "",
        event.meetingUrl ? `Join: ${event.meetingUrl}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
      startAt,
      endAt,
    });
  });

  if (event.contactId) {
    try {
      const content = targetName
        ? `Booking "${event.title || "Meeting"}" reassigned to ${targetName}.`
        : `Booking "${event.title || "Meeting"}" host cleared.`;
      await db
        .collection("contacts")
        .doc(event.contactId)
        .collection("activities")
        .add({
          type: "booking_reassigned" satisfies ActivityType,
          content,
          createdBy: access.uid,
          meta: { eventId, assignedToUid: targetUid ?? undefined },
          createdAt: FieldValue.serverTimestamp(),
        });
    } catch (err) {
      console.warn(`[events/assign] activity write failed event=${eventId}`, err);
    }
  }

  return NextResponse.json({
    ok: true,
    assignedToUid: targetUid,
    assignedToName: targetName,
  });
}
