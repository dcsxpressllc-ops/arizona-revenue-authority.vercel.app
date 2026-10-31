import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  requireAgencyOwner,
  requireSubAccountAdmin,
} from "@/lib/auth/require-tenancy";
import {
  findDedicatedNumberHolder,
  invalidateSubAccountTwilioCache,
} from "@/lib/comms/twilio";
import {
  autoConfigureInboundWebhook,
  validateCredentials,
} from "@/lib/comms/twilio-config";
import type { TwilioConfig } from "@/types";

/**
 * Per-sub-account Twilio config.
 *
 * POST { accountSid, authToken, fromNumber }: admin only. Refuses a number
 * another sub-account already holds, validates the creds against Twilio,
 * best-effort points the number's smsUrl at us (failure is reported, not
 * fatal), saves with enabled: true, and drops the cached client so new
 * creds apply without a restart.
 *
 * DELETE: sets enabled: false but keeps the creds for a one-click re-enable.
 * The Twilio-side webhook is left pointing at us.
 */

interface PostBody {
  accountSid?: string;
  authToken?: string;
  fromNumber?: string;
}

function inboundWebhookUrl(): string {
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
  return `${base}/api/webhooks/twilio/inbound`;
}

function normalisePhone(s: string): string {
  let cleaned = s.trim().replace(/[\s\-()]/g, "");
  if (cleaned.startsWith("00")) cleaned = "+" + cleaned.slice(2);
  return cleaned;
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const accountSid = body.accountSid?.trim() ?? "";
  const fromNumberRaw = body.fromNumber?.trim() ?? "";
  const fromNumber = fromNumberRaw ? normalisePhone(fromNumberRaw) : "";

  // The auth token is write-only, so a blank field on an existing config means
  // "keep the saved token".
  const existingSnap = await getAdminDb()
    .doc(`subAccounts/${subAccountId}`)
    .get();
  const existingCfg =
    (existingSnap.data() as { twilioConfig?: TwilioConfig } | undefined)
      ?.twilioConfig ?? null;

  const submittedToken = body.authToken?.trim() ?? "";
  const authToken = submittedToken || existingCfg?.authToken || "";

  if (!accountSid || !fromNumber) {
    return NextResponse.json(
      { error: "accountSid and fromNumber are both required." },
      { status: 400 },
    );
  }
  if (!authToken) {
    return NextResponse.json(
      {
        error:
          "Auth token is required. Paste it from your Twilio console — there's no saved token to reuse yet.",
      },
      { status: 400 },
    );
  }
  if (!fromNumber.startsWith("+")) {
    return NextResponse.json(
      { error: "fromNumber must be E.164 (e.g. +15551234567)." },
      { status: 400 },
    );
  }
  if (!accountSid.startsWith("AC")) {
    return NextResponse.json(
      { error: "accountSid should start with AC (Twilio Account SID format)." },
      { status: 400 },
    );
  }

  // Inbound routing looks up the sub-account by fromNumber with limit(1), so
  // a second claim would silently hijack (or with a different token,
  // 403-break) the first one's inbound traffic.
  const holder = await findDedicatedNumberHolder({
    field: "fromNumber",
    number: fromNumber,
    excludeSubAccountId: subAccountId,
  });
  if (holder) {
    return NextResponse.json(
      {
        error: `${fromNumber} is already the dedicated SMS number for "${holder}". Saving would silently take over its inbound routing — use a different number, or disable the Twilio config on that sub-account first.`,
      },
      { status: 409 },
    );
  }

  const validation = await validateCredentials(accountSid, authToken);
  if (!validation.ok) {
    return NextResponse.json(
      { error: `Twilio rejected the credentials: ${validation.error ?? "unknown"}` },
      { status: 400 },
    );
  }

  const webhookUrl = inboundWebhookUrl();
  let webhookResult = { ok: false, error: null as string | null };
  if (webhookUrl) {
    webhookResult = await autoConfigureInboundWebhook({
      accountSid,
      authToken,
      fromNumber,
      webhookUrl,
    });
  } else {
    webhookResult.error =
      "NEXT_PUBLIC_APP_URL is not set on this deployment — webhook URL must be configured manually.";
  }

  const cfg: TwilioConfig = {
    enabled: true,
    accountSid,
    authToken,
    fromNumber,
    inboundWebhookConfigured: webhookResult.ok,
    lastValidatedAt: new Date(),
    inboundWebhookSecret: null,
  };
  await getAdminDb()
    .doc(`subAccounts/${subAccountId}`)
    .set(
      {
        twilioConfig: cfg,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

  invalidateSubAccountTwilioCache(subAccountId);

  return NextResponse.json({
    ok: true,
    friendlyName: validation.friendlyName,
    inboundWebhookConfigured: webhookResult.ok,
    inboundWebhookUrl: webhookUrl,
    inboundWebhookError: webhookResult.error,
  });
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  // Owner only, unlike POST. Saving your own creds spends your own Twilio
  // balance; falling back to the shared sender spends the agency's and makes
  // inbound replies unroutable (routing is by dedicated number).
  const subSnap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  if (!subSnap.exists) {
    return NextResponse.json({ error: "Sub-account not found" }, { status: 404 });
  }
  const agencyId = (subSnap.data()?.agencyId as string) ?? "";
  const access = await requireAgencyOwner(request, agencyId);
  if (access instanceof NextResponse) return access;

  // Keep the creds for a one-click re-enable. update() so the dotted key is a
  // field path; set({merge:true}) would write a literal "twilioConfig.enabled"
  // field.
  await getAdminDb()
    .doc(`subAccounts/${subAccountId}`)
    .update({
      "twilioConfig.enabled": false,
      updatedAt: FieldValue.serverTimestamp(),
    });

  invalidateSubAccountTwilioCache(subAccountId);
  return NextResponse.json({ ok: true });
}
