import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import {
  emailInboxWebhookConfigured,
  inboundReplyAddress,
} from "@/lib/comms/email-inbox";
import {
  enableDomainReceiving,
  getSendingDomain,
} from "@/lib/comms/resend-domains";
import type { ResendConfig, SubAccountDoc } from "@/types";

/**
 * Two-way email opt-in for a sub-account.
 * POST: enable. Needs the agency email-domain gate, a verified sending
 * domain, and RESEND_WEBHOOK_SECRET (without it inbound mail has nowhere to
 * go). Turns on `capabilities.receiving` for the Resend domain and re-reads
 * DNS so the inbound MX rows show up.
 * DELETE: local flag only. Receiving stays on at Resend; the webhook's
 * inboxEnabled check drops the mail, and re-enabling is instant.
 */

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  if (!process.env.RESEND_API_KEY) {
    return NextResponse.json(
      { error: "Resend isn't configured on this deployment (RESEND_API_KEY)." },
      { status: 503 },
    );
  }
  if (!emailInboxWebhookConfigured()) {
    return NextResponse.json(
      {
        error:
          "The inbound-email webhook isn't configured on this deployment (RESEND_WEBHOOK_SECRET). Create an email.received webhook in the Resend dashboard first — see the setup guide.",
      },
      { status: 503 },
    );
  }

  const db = getAdminDb();
  const subRef = db.doc(`subAccounts/${subAccountId}`);
  const sub = ((await subRef.get()).data() ?? {}) as Partial<SubAccountDoc>;

  if (sub.emailDomainEnabledByAgency !== true) {
    return NextResponse.json(
      {
        error:
          "The dedicated email sending domain feature is disabled for this sub-account. Ask your agency owner to enable it.",
      },
      { status: 403 },
    );
  }
  const cfg = sub.resendConfig as ResendConfig | null | undefined;
  if (!cfg || cfg.status !== "verified") {
    return NextResponse.json(
      { error: "Verify your sending domain first — the inbox receives replies on that domain." },
      { status: 400 },
    );
  }

  const enabled = await enableDomainReceiving(cfg.domainId);
  if (!enabled.ok) {
    return NextResponse.json(
      { error: enabled.error ?? "Failed to enable receiving on Resend." },
      { status: 502 },
    );
  }

  await subRef.set(
    {
      resendConfig: { ...cfg, inboxEnabled: true },
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  // So the card can show the inbound MX row right away.
  const fresh = await getSendingDomain(cfg.domainId);
  return NextResponse.json({
    ok: true,
    replyAddress: inboundReplyAddress(cfg),
    records: fresh.records,
  });
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
  const cfg = (await subRef.get()).data()?.resendConfig as
    | ResendConfig
    | null
    | undefined;
  if (cfg) {
    await subRef.set(
      {
        resendConfig: { ...cfg, inboxEnabled: false },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }
  return NextResponse.json({ ok: true });
}
