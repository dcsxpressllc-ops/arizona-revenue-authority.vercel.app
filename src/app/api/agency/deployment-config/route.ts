import "server-only";

import { NextResponse } from "next/server";
import { metaAppConfigured } from "@/lib/comms/meta";
import { emailIsConfigured } from "@/lib/comms/resend";
import { smsIsConfigured } from "@/lib/comms/twilio";
import { googleCalendarConfigured } from "@/lib/google/calendar";

/**
 * Which optional deployment-level integrations have env vars set, so the UI
 * can disable controls that can't work yet. Booleans only. Middleware already
 * requires auth; we also require the forwarded uid header.
 */
export async function GET(request: Request) {
  if (!request.headers.get("x-user-uid")) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  return NextResponse.json({
    ok: true,
    // META_APP_ID + META_APP_SECRET; FB/IG inbox and Social Planner share one connection
    metaConfigured: metaAppConfigured(),
    // RESEND_API_KEY + EMAIL_FROM; workflow Send email + Internal notification need it
    emailConfigured: emailIsConfigured(),
    // Shared Twilio only. A sub-account may also have its own Twilio (checked
    // client-side), so the builder ORs the two.
    smsConfigured: smsIsConfigured(),
    // GOOGLE_OAUTH_CLIENT_ID + secret, for two-way Google Calendar sync
    googleCalendarConfigured: googleCalendarConfigured(),
  });
}
