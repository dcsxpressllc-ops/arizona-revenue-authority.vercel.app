import "server-only";

import { NextResponse } from "next/server";

import {
  hashEventToken,
  verifyEventToken,
} from "@/lib/booking/event-token";
import { rescheduleBooking } from "@/lib/server/booking-changes-service";

/**
 * Public reschedule; the HMAC token is the credential. The move itself
 * (re-verify, token rotation, reminders, fresh confirmation + ICS) lives in
 * booking-changes-service so the AI agent shares it.
 */

interface RescheduleBody {
  slot?: { startAt?: string; endAt?: string };
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ token: string }> },
) {
  const { token } = await ctx.params;

  const verified = verifyEventToken(token);
  if (!verified) {
    return NextResponse.json({ error: "Invalid link" }, { status: 404 });
  }

  let body: RescheduleBody;
  try {
    body = (await request.json()) as RescheduleBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const newStart = body.slot?.startAt ? new Date(body.slot.startAt) : null;
  const newEnd = body.slot?.endAt ? new Date(body.slot.endAt) : null;
  if (
    !newStart ||
    !newEnd ||
    Number.isNaN(newStart.getTime()) ||
    Number.isNaN(newEnd.getTime()) ||
    newEnd <= newStart
  ) {
    return NextResponse.json(
      { error: "Pick a valid new time." },
      { status: 400 },
    );
  }
  if (newStart.getTime() <= Date.now()) {
    return NextResponse.json(
      { error: "Choose a time in the future." },
      { status: 400 },
    );
  }

  const tokenHash = hashEventToken(token);
  const result = await rescheduleBooking({
    eventId: verified.eventId,
    newStart,
    newEnd,
    guard: (event) => event.publicTokenHash === tokenHash,
  });

  if (result.ok) {
    return NextResponse.json({
      ok: true,
      newStartAt: result.newStart.toISOString(),
      newEndAt: result.newEnd.toISOString(),
      newToken: result.newToken,
      publicEventUrl: result.publicEventUrl,
    });
  }
  if (result.code === "invalid") {
    return NextResponse.json({ error: "Invalid link" }, { status: 404 });
  }
  if (result.code === "bad_state") {
    return NextResponse.json({ error: result.message }, { status: 409 });
  }
  if (result.code === "slot_taken") {
    return NextResponse.json(
      { error: "That time was just taken. Refresh and pick another option." },
      { status: 409 },
    );
  }
  return NextResponse.json(
    { error: "Couldn't reschedule. Try again." },
    { status: 500 },
  );
}
