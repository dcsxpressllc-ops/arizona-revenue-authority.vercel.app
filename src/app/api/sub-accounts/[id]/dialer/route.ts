import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { buildTwilioClient } from "@/lib/comms/twilio";
import {
  dialerPrivateRef,
  dialerTwimlUrl,
  getDialerPrivate,
} from "@/lib/comms/dialer";
import type { SubAccountDoc, TwilioConfig } from "@/types";

/**
 * Browser dialer provisioning. All admin-gated.
 * POST: enable. Needs the sub-account's own Twilio (`twilioConfig.enabled`,
 * creds, fromNumber). Creates an API Key + TwiML App (voice URL -> our TwiML
 * webhook) on that account; secrets go in `subAccounts/{id}/private/dialer`,
 * client-visible flags in `dialerConfig`. Re-enabling refreshes the voice URL
 * so a changed NEXT_PUBLIC_APP_URL heals on re-save.
 * PATCH: { recordCalls: boolean }.
 * DELETE: best-effort removes the TwiML App + key, deletes the private doc,
 * clears dialerConfig.
 *
 * No agency feature gate: the dialer only spends the client's own Twilio
 * minutes, like manual SMS.
 */

function twilioReady(cfg: TwilioConfig | null | undefined): cfg is TwilioConfig {
  return (
    cfg?.enabled === true &&
    !!cfg.accountSid &&
    !!cfg.authToken &&
    !!cfg.fromNumber
  );
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  if (!process.env.NEXT_PUBLIC_APP_URL) {
    return NextResponse.json(
      { error: "NEXT_PUBLIC_APP_URL is not configured on this deployment." },
      { status: 503 },
    );
  }

  const db = getAdminDb();
  const subRef = db.doc(`subAccounts/${subAccountId}`);
  const sub = ((await subRef.get()).data() ?? {}) as Partial<SubAccountDoc>;

  if (!twilioReady(sub.twilioConfig)) {
    return NextResponse.json(
      {
        error:
          "Set up your dedicated Twilio number first (Settings → SMS). The dialer calls through your own Twilio account.",
      },
      { status: 400 },
    );
  }

  const client = buildTwilioClient(
    sub.twilioConfig.accountSid,
    sub.twilioConfig.authToken,
  );
  const voiceUrl = dialerTwimlUrl(subAccountId);

  try {
    const existing = await getDialerPrivate(subAccountId);
    if (existing) {
      await client.applications(existing.twimlAppSid).update({
        voiceUrl,
        voiceMethod: "POST",
      });
    } else {
      const app = await client.applications.create({
        friendlyName: `LeadStack dialer sa:${subAccountId}`,
        voiceUrl,
        voiceMethod: "POST",
      });
      const key = await client.newKeys.create({
        friendlyName: `LeadStack dialer sa:${subAccountId}`,
      });
      await dialerPrivateRef(subAccountId).set({
        apiKeySid: key.sid,
        apiKeySecret: key.secret,
        twimlAppSid: app.sid,
        createdAt: FieldValue.serverTimestamp(),
      });
    }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Twilio provisioning failed.";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  await subRef.set(
    {
      dialerConfig: {
        enabled: true,
        recordCalls: sub.dialerConfig?.recordCalls === true,
      },
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  return NextResponse.json({ ok: true });
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: { recordCalls?: boolean };
  try {
    body = (await request.json()) as { recordCalls?: boolean };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.recordCalls !== "boolean") {
    return NextResponse.json(
      { error: "recordCalls (boolean) is required" },
      { status: 400 },
    );
  }

  const db = getAdminDb();
  const subRef = db.doc(`subAccounts/${subAccountId}`);
  const sub = ((await subRef.get()).data() ?? {}) as Partial<SubAccountDoc>;
  if (sub.dialerConfig?.enabled !== true) {
    return NextResponse.json(
      { error: "Enable the dialer first." },
      { status: 400 },
    );
  }

  await subRef.set(
    {
      dialerConfig: { enabled: true, recordCalls: body.recordCalls },
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const db = getAdminDb();
  const subRef = db.doc(`subAccounts/${subAccountId}`);
  const sub = ((await subRef.get()).data() ?? {}) as Partial<SubAccountDoc>;
  const priv = await getDialerPrivate(subAccountId);

  // Best-effort; a failed remote delete never blocks disabling.
  if (priv && twilioReady(sub.twilioConfig)) {
    const client = buildTwilioClient(
      sub.twilioConfig.accountSid,
      sub.twilioConfig.authToken,
    );
    await client
      .applications(priv.twimlAppSid)
      .remove()
      .catch(() => undefined);
    await client
      .keys(priv.apiKeySid)
      .remove()
      .catch(() => undefined);
  }
  await dialerPrivateRef(subAccountId)
    .delete()
    .catch(() => undefined);

  await subRef.set(
    { dialerConfig: null, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
  return NextResponse.json({ ok: true });
}
