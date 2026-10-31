import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import {
  findDedicatedNumberHolder,
  invalidateSubAccountTwilioCache,
  subAccountTwilioIsConfigured,
} from "@/lib/comms/twilio";
import { autoConfigureInboundWebhook } from "@/lib/comms/twilio-config";
import type { SubAccountDoc } from "@/types";

/**
 * WhatsApp sender for a sub-account. Reuses the SMS Twilio creds, so this
 * only manages the sender number and sandbox flag; an enabled SMS config is
 * required first.
 *
 * POST { whatsappFromNumber, sandbox? }: admin only. Refuses a sender another
 * sub-account holds and best-effort configures its inbound webhook (both
 * skipped in sandbox). Writes via dotted keys so the SMS fields are untouched.
 * DELETE: whatsappFromNumber -> null; creds and SMS config stay.
 */

interface PostBody {
  whatsappFromNumber?: string;
  sandbox?: boolean;
}

/** Twilio's shared WhatsApp Sandbox number. */
const SANDBOX_NUMBER = "+14155238886";

function whatsappWebhookUrl(): string {
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
  return base ? `${base}/api/webhooks/twilio/whatsapp/inbound` : "";
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

  const sandbox = body.sandbox === true;
  const raw = body.whatsappFromNumber?.trim() ?? "";
  const whatsappFromNumber = sandbox
    ? SANDBOX_NUMBER
    : raw
      ? normalisePhone(raw)
      : "";

  if (!whatsappFromNumber) {
    return NextResponse.json(
      { error: "whatsappFromNumber is required (or set sandbox: true)." },
      { status: 400 },
    );
  }
  if (!whatsappFromNumber.startsWith("+")) {
    return NextResponse.json(
      { error: "whatsappFromNumber must be E.164 (e.g. +15551234567)." },
      { status: 400 },
    );
  }

  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  const cfg = (snap.data() as SubAccountDoc | undefined)?.twilioConfig ?? null;
  if (!subAccountTwilioIsConfigured(cfg) || !cfg) {
    return NextResponse.json(
      {
        error:
          "Configure your dedicated Twilio number (Settings → SMS) first — WhatsApp reuses those credentials.",
      },
      { status: 400 },
    );
  }

  // Inbound routes by whatsappFromNumber with limit(1), so a duplicate claim
  // hijacks the first one's traffic. Sandbox is exempt: everyone shares its
  // number, and that ambiguity is accepted for testing.
  if (!sandbox) {
    const holder = await findDedicatedNumberHolder({
      field: "whatsappFromNumber",
      number: whatsappFromNumber,
      excludeSubAccountId: subAccountId,
    });
    if (holder) {
      return NextResponse.json(
        {
          error: `${whatsappFromNumber} is already the WhatsApp sender for "${holder}". Saving would silently take over its inbound routing — use a different number, or clear the WhatsApp sender on that sub-account first.`,
        },
        { status: 409 },
      );
    }
  }

  // Not for sandbox: that number isn't on the operator's account, so the
  // IncomingPhoneNumbers PATCH can't find it. Configure it in the console.
  const webhookUrl = whatsappWebhookUrl();
  let webhookResult = { ok: false, error: null as string | null };
  if (sandbox) {
    webhookResult.error =
      "Sandbox inbound is configured in the Twilio console (Messaging → Try it out → WhatsApp sandbox settings).";
  } else if (!webhookUrl) {
    webhookResult.error =
      "NEXT_PUBLIC_APP_URL is not set on this deployment — set the inbound webhook URL manually in Twilio.";
  } else {
    webhookResult = await autoConfigureInboundWebhook({
      accountSid: cfg.accountSid,
      authToken: cfg.authToken,
      fromNumber: whatsappFromNumber,
      webhookUrl,
    });
  }

  // update(), not set+merge: with merge a dotted key like
  // "twilioConfig.whatsappFromNumber" becomes a literal top-level field
  // instead of the nested one the UI and webhook read. The doc always exists
  // here (SMS creds were saved first).
  await getAdminDb()
    .doc(`subAccounts/${subAccountId}`)
    .update({
      "twilioConfig.whatsappFromNumber": whatsappFromNumber,
      "twilioConfig.whatsappSandbox": sandbox,
      "twilioConfig.whatsappInboundWebhookConfigured": webhookResult.ok,
      updatedAt: FieldValue.serverTimestamp(),
    });

  invalidateSubAccountTwilioCache(subAccountId);

  return NextResponse.json({
    ok: true,
    whatsappFromNumber,
    sandbox,
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
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  await getAdminDb()
    .doc(`subAccounts/${subAccountId}`)
    .update({
      "twilioConfig.whatsappFromNumber": null,
      "twilioConfig.whatsappSandbox": false,
      "twilioConfig.whatsappInboundWebhookConfigured": false,
      updatedAt: FieldValue.serverTimestamp(),
    });

  invalidateSubAccountTwilioCache(subAccountId);
  return NextResponse.json({ ok: true });
}
