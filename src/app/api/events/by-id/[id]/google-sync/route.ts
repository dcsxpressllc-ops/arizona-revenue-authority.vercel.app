import "server-only";

import { NextResponse } from "next/server";

import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { territoryGate } from "@/lib/auth/territory-filter";
import {
  deleteGoogleBookingCopy,
  syncEventEditToGoogle,
  timestampToDate,
} from "@/lib/booking/lifecycle";
import { isImportedEvent, type CalendarEvent } from "@/types/events";

/**
 * Dashboard calendar edits and deletes are client-side Firestore writes, so
 * the dialog calls this to mirror them onto the Google copy: "update" after
 * the edit lands, "delete" BEFORE the doc is removed (the Google id lives on
 * it). Any active member. Google failures are logged, never surfaced.
 */

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: eventId } = await ctx.params;

  let action: unknown;
  try {
    action = ((await request.json()) as { action?: unknown }).action;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (action !== "update" && action !== "delete") {
    return NextResponse.json(
      { error: "action must be update or delete" },
      { status: 400 },
    );
  }

  // One 404 for missing, foreign and out-of-territory events, so the route
  // can't be used to probe which event ids exist.
  const notFound = () =>
    NextResponse.json({ error: "Event not found" }, { status: 404 });

  const snap = await getAdminDb().collection("events").doc(eventId).get();
  if (!snap.exists) return notFound();
  const event = { ...(snap.data() as CalendarEvent), id: eventId };

  const access = await requireSubAccountMember(request, event.subAccountId);
  if (access instanceof NextResponse) return notFound();
  // Same visibility as the Firestore rules: a scoped collaborator can only
  // touch events in their territories.
  if (await territoryGate(access, event.territoryId)) return notFound();
  // Imported events mirror someone's own calendar; the CRM never writes back.
  if (isImportedEvent(event)) {
    return NextResponse.json(
      { error: "Imported Google events are read-only." },
      { status: 400 },
    );
  }

  if (action === "delete") {
    await deleteGoogleBookingCopy(event);
    return NextResponse.json({ ok: true });
  }

  const startAt = timestampToDate(
    event.startAt as { toDate?: () => Date } | null,
  );
  const endAt = timestampToDate(event.endAt as { toDate?: () => Date } | null);
  if (!startAt || !endAt) {
    return NextResponse.json({ ok: true, skipped: "bad_timestamps" });
  }
  await syncEventEditToGoogle(event, startAt, endAt);
  return NextResponse.json({ ok: true });
}
