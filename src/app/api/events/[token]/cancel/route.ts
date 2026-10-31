import "server-only";

import { NextResponse } from "next/server";

import {
  hashEventToken,
  verifyEventToken,
} from "@/lib/booking/event-token";
import { cancelBooking } from "@/lib/server/booking-changes-service";

/**
 * Public cancel. The HMAC token is the credential, no session needed.
 * Best-effort side effects: visitor email, activity row, automation trigger
 * (see booking-changes-service).
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ token: string }> },
) {
  const { token } = await ctx.params;

  const verified = verifyEventToken(token);
  if (!verified) {
    return NextResponse.json({ error: "Invalid link" }, { status: 404 });
  }

  const tokenHash = hashEventToken(token);
  const result = await cancelBooking({
    eventId: verified.eventId,
    guard: (event) => event.publicTokenHash === tokenHash,
    note: "by attendee",
  });

  if (result.ok) return NextResponse.json({ ok: true });
  if (result.code === "invalid") {
    return NextResponse.json({ error: "Invalid link" }, { status: 404 });
  }
  if (result.code === "bad_state") {
    return NextResponse.json({ error: result.message }, { status: 409 });
  }
  return NextResponse.json(
    { error: "Couldn't cancel. Try again." },
    { status: 500 },
  );
}
