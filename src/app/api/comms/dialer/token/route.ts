import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  dialerEnabled,
  getDialerPrivate,
  mintDialerToken,
} from "@/lib/comms/dialer";
import type { SubAccountDoc } from "@/types";

/**
 * Mint a short-TTL Twilio Voice AccessToken for the browser softphone. Any
 * active member may call (same trust as sending an SMS). The API key secret
 * stays in the Admin-SDK-only private doc; the browser only sees this JWT.
 */
export async function POST(request: Request) {
  let body: { subAccountId?: string };
  try {
    body = (await request.json()) as { subAccountId?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const subAccountId = body.subAccountId?.trim();
  if (!subAccountId) {
    return NextResponse.json(
      { error: "subAccountId is required" },
      { status: 400 },
    );
  }

  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const sub = (
    await getAdminDb().doc(`subAccounts/${subAccountId}`).get()
  ).data() as SubAccountDoc | undefined;

  if (!dialerEnabled(sub)) {
    return NextResponse.json(
      { error: "The dialer isn't enabled for this workspace." },
      { status: 403 },
    );
  }
  const accountSid = sub?.twilioConfig?.accountSid;
  const priv = await getDialerPrivate(subAccountId);
  if (!accountSid || !priv) {
    return NextResponse.json(
      { error: "The dialer isn't fully provisioned — re-enable it in Settings." },
      { status: 503 },
    );
  }

  const token = mintDialerToken({
    accountSid,
    apiKeySid: priv.apiKeySid,
    apiKeySecret: priv.apiKeySecret,
    twimlAppSid: priv.twimlAppSid,
    identity: access.uid,
  });

  return NextResponse.json({ ok: true, token, ttlSeconds: 3600 });
}
