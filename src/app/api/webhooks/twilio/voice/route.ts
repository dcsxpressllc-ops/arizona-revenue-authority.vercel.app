import "server-only";

import { NextResponse } from "next/server";
import twilio from "twilio";
import {
  DEFAULT_MCTB_RING_TIMEOUT_SEC,
  normalisePhone,
  resolveVoiceRoute,
} from "@/lib/comms/missed-call";

export const dynamic = "force-dynamic";

/**
 * Missed Call Text Back: inbound voice webhook. Only MCTB-enabled numbers
 * point their Voice URL here. Returns TwiML forwarding to the business's
 * real phone with a ring timeout; Twilio then calls /voice/status with the
 * result, which sends the text-back if unanswered.
 *
 * Same routing and signature model as inbound SMS. Always 200; a number that
 * isn't MCTB-routed gets a bare <Response/> and the call ends.
 */

function xml(body: string): NextResponse {
  return new NextResponse(body, {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}

const EMPTY = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function statusCallbackUrl(): string {
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
  return `${base}/api/webhooks/twilio/voice/status`;
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  const params = Object.fromEntries(new URLSearchParams(rawBody).entries());

  const to = normalisePhone((params["To"] as string | undefined) ?? "");
  const from = (params["From"] as string | undefined) ?? "";

  const route = await resolveVoiceRoute(to);
  if (!route) {
    // Not MCTB (or turned off); end the call cleanly.
    return xml(EMPTY);
  }

  const signature = request.headers.get("x-twilio-signature");
  if (!signature) return xml(EMPTY);
  const proto = request.headers.get("x-forwarded-proto") ?? "https";
  const host =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const url = new URL(request.url);
  const fullUrl = `${proto}://${host ?? url.host}${url.pathname}`;
  const valid = twilio.validateRequest(
    route.authToken,
    signature,
    fullUrl,
    params,
  );
  if (!valid) {
    console.warn(
      `[twilio/voice] invalid signature (sa=${route.subAccountId})`,
    );
    return new NextResponse("Invalid signature", { status: 403 });
  }

  const timeout = Math.min(
    60,
    Math.max(5, route.missedCall.ringTimeoutSec || DEFAULT_MCTB_RING_TIMEOUT_SEC),
  );
  const action = statusCallbackUrl();
  // Pass the caller's number through so the business sees who's calling.
  const callerId = escapeXml(normalisePhone(from));
  const forwardTo = escapeXml(route.missedCall.forwardTo);

  const twiml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    "<Response>" +
    `<Dial timeout="${timeout}" callerId="${callerId}" action="${escapeXml(action)}" method="POST">` +
    `<Number>${forwardTo}</Number>` +
    "</Dial>" +
    "</Response>";

  return xml(twiml);
}
