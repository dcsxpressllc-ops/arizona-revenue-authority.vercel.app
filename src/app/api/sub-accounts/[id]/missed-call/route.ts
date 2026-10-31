import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { subAccountTwilioIsConfigured } from "@/lib/comms/twilio";
import {
  configureVoiceWebhook,
  restoreVoiceWebhook,
} from "@/lib/comms/twilio-config";
import {
  DEFAULT_MCTB_MESSAGE,
  DEFAULT_MCTB_RING_TIMEOUT_SEC,
} from "@/lib/comms/missed-call";
import type { MissedCallConfig, SubAccountDoc } from "@/types";

/**
 * Missed Call Text Back config.
 * POST { forwardTo, ringTimeoutSec?, messageBody? }: enable/update. Needs the
 * agency gate, dedicated Twilio, and AI inbound Voice off (a number has one
 * Voice URL and AI Voice hands it to Vapi). Points the number's Voice URL at
 * our handler, saving the prior URL for restore.
 * DELETE: restores the prior Voice URL (best-effort) and turns
 * `missedCall.enabled` off, keeping the rest for a one-click re-enable.
 */

interface PostBody {
  forwardTo?: string;
  ringTimeoutSec?: number;
  messageBody?: string;
}

function voiceWebhookUrl(): string {
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
  return `${base}/api/webhooks/twilio/voice`;
}

function normalisePhone(s: string): string {
  let cleaned = s.trim().replace(/[\s\-()]/g, "");
  if (cleaned.startsWith("00")) cleaned = "+" + cleaned.slice(2);
  return cleaned;
}

async function aiVoiceEnabled(subAccountId: string): Promise<boolean> {
  try {
    const snap = await getAdminDb()
      .doc(`subAccounts/${subAccountId}/aiAgent/voice`)
      .get();
    return snap.exists && (snap.data()?.enabled as boolean | undefined) === true;
  } catch {
    return false;
  }
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

  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Sub-account not found" }, { status: 404 });
  }
  const sa = snap.data() as SubAccountDoc;
  const cfg = sa.twilioConfig ?? null;

  if (sa.missedCallTextBackEnabledByAgency !== true) {
    return NextResponse.json(
      { error: "Missed Call Text Back is disabled by your agency." },
      { status: 403 },
    );
  }
  // Dedicated Twilio: we need the number and creds.
  if (!subAccountTwilioIsConfigured(cfg) || !cfg) {
    return NextResponse.json(
      {
        error:
          "Enable a dedicated Twilio number for this sub-account first (Settings → SMS).",
      },
      { status: 400 },
    );
  }
  // One Voice URL per number, and AI Voice gives it to Vapi.
  if (await aiVoiceEnabled(subAccountId)) {
    return NextResponse.json(
      {
        error:
          "AI inbound Voice is enabled on this number — it already answers calls. Turn off AI Voice (AI Agents → Voice) before enabling Missed Call Text Back.",
      },
      { status: 409 },
    );
  }

  const forwardTo = normalisePhone(body.forwardTo ?? "");
  if (!forwardTo.startsWith("+")) {
    return NextResponse.json(
      { error: "forwardTo must be E.164 (e.g. +15551234567)." },
      { status: 400 },
    );
  }
  const ringTimeoutSec = Math.min(
    60,
    Math.max(5, Math.round(body.ringTimeoutSec || DEFAULT_MCTB_RING_TIMEOUT_SEC)),
  );
  const messageBody = (body.messageBody ?? "").trim() || DEFAULT_MCTB_MESSAGE;

  // Save the prior URL for restore. Keep an already-saved prevVoiceUrl so a
  // second enable doesn't overwrite it with our own URL.
  const webhookUrl = voiceWebhookUrl();
  let voiceWebhookConfigured = false;
  let webhookError: string | null = null;
  let prevVoiceUrl = cfg.missedCall?.prevVoiceUrl ?? null;
  if (!webhookUrl) {
    webhookError =
      "NEXT_PUBLIC_APP_URL is not set on this deployment — configure the number's Voice URL manually.";
  } else {
    const result = await configureVoiceWebhook({
      accountSid: cfg.accountSid,
      authToken: cfg.authToken,
      fromNumber: cfg.fromNumber,
      webhookUrl,
    });
    voiceWebhookConfigured = result.ok;
    webhookError = result.error;
    // Guards a double enable: ignore the read value if it's our own endpoint.
    if (
      prevVoiceUrl === null &&
      result.prevVoiceUrl &&
      result.prevVoiceUrl !== webhookUrl
    ) {
      prevVoiceUrl = result.prevVoiceUrl;
    }
  }

  const missedCall: MissedCallConfig = {
    enabled: true,
    forwardTo,
    ringTimeoutSec,
    messageBody,
    prevVoiceUrl,
    voiceWebhookConfigured,
  };
  await getAdminDb()
    .doc(`subAccounts/${subAccountId}`)
    .update({
      "twilioConfig.missedCall": missedCall,
      updatedAt: FieldValue.serverTimestamp(),
    });

  return NextResponse.json({
    ok: true,
    voiceWebhookConfigured,
    voiceWebhookUrl: webhookUrl,
    voiceWebhookError: webhookError,
  });
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  const sa = snap.data() as SubAccountDoc | undefined;
  const cfg = sa?.twilioConfig ?? null;

  if (cfg?.accountSid && cfg.authToken && cfg.fromNumber) {
    await restoreVoiceWebhook({
      accountSid: cfg.accountSid,
      authToken: cfg.authToken,
      fromNumber: cfg.fromNumber,
      prevVoiceUrl: cfg.missedCall?.prevVoiceUrl ?? null,
    });
  }

  await getAdminDb()
    .doc(`subAccounts/${subAccountId}`)
    .update({
      "twilioConfig.missedCall.enabled": false,
      "twilioConfig.missedCall.voiceWebhookConfigured": false,
      updatedAt: FieldValue.serverTimestamp(),
    });

  return NextResponse.json({ ok: true });
}
