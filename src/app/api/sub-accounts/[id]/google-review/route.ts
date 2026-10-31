import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { subAccountWhatsappIsConfigured } from "@/lib/comms/twilio";
import {
  DEFAULT_REVIEW_COOLDOWN_DAYS,
  DEFAULT_REVIEW_SMS_TEMPLATE,
  normalizeReviewChannel,
} from "@/lib/reviews/constants";
import type { SubAccountDoc } from "@/types";
import type { GoogleReviewConfig } from "@/types/tenancy";
import type { WhatsappTemplateDoc } from "@/types/whatsapp-templates";

/**
 * Google review-request config. Admin-only.
 * POST saves it, enforcing the same rules as the UI: https review URL, SMS
 * body contains {{reviewUrl}}, and WhatsApp needs the agency gate, a sender
 * and an approved template. DELETE clears it.
 */

interface PostBody {
  enabled?: boolean;
  reviewUrl?: string;
  channel?: "sms" | "whatsapp_template" | "whatsapp_manual";
  messageTemplate?: string;
  whatsappTemplateId?: string | null;
  cooldownDays?: number;
  triggerOnQuotePaid?: boolean;
  triggerOnDealCompleted?: boolean;
}

function isHttpsUrl(s: string): boolean {
  try {
    return new URL(s).protocol === "https:";
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

  const reviewUrl = body.reviewUrl?.trim() ?? "";
  if (!reviewUrl || !isHttpsUrl(reviewUrl)) {
    return NextResponse.json(
      { error: "Enter a valid https Google review link." },
      { status: 400 },
    );
  }

  const channel = normalizeReviewChannel(body.channel);
  const isWhatsapp = channel !== "sms";
  const messageTemplate =
    body.messageTemplate?.trim() || DEFAULT_REVIEW_SMS_TEMPLATE;

  // sms and whatsapp_manual carry the link in the body.
  if (channel !== "whatsapp_template" && !messageTemplate.includes("{{reviewUrl}}")) {
    return NextResponse.json(
      { error: "The message must include {{reviewUrl}} so the link is sent." },
      { status: 400 },
    );
  }

  let whatsappTemplateId: string | null = null;
  if (isWhatsapp) {
    // Both WhatsApp modes need the agency gate on and a sender configured. Also
    // refuses a save if the agency has since turned WhatsApp off.
    const subSnap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
    const sub = subSnap.exists ? (subSnap.data() as SubAccountDoc) : null;
    if (sub?.whatsappEnabledByAgency !== true) {
      return NextResponse.json(
        {
          error:
            "WhatsApp is disabled for this sub-account by your agency. Ask the agency owner to enable WhatsApp first.",
        },
        { status: 403 },
      );
    }
    if (!subAccountWhatsappIsConfigured(sub?.twilioConfig)) {
      return NextResponse.json(
        {
          error:
            "Add a WhatsApp sender under Settings → SMS before using WhatsApp for review requests.",
        },
        { status: 400 },
      );
    }

    // Manual mode is free-form (in-window), so only template mode needs one.
    if (channel === "whatsapp_template") {
      whatsappTemplateId = body.whatsappTemplateId?.trim() || null;
      if (!whatsappTemplateId) {
        return NextResponse.json(
          { error: "Pick an approved WhatsApp template for review requests." },
          { status: 400 },
        );
      }
      const tplSnap = await getAdminDb()
        .doc(`subAccounts/${subAccountId}/whatsappTemplates/${whatsappTemplateId}`)
        .get();
      const tpl = tplSnap.exists ? (tplSnap.data() as WhatsappTemplateDoc) : null;
      if (!tpl || tpl.status !== "approved" || !tpl.contentSid) {
        return NextResponse.json(
          { error: "That WhatsApp template isn't approved yet — only approved templates can be used." },
          { status: 400 },
        );
      }
    }
  }

  const cooldownDays = clampCooldown(body.cooldownDays);

  const cfg: GoogleReviewConfig = {
    enabled: body.enabled === true,
    reviewUrl,
    channel,
    messageTemplate,
    whatsappTemplateId,
    cooldownDays,
    triggerOnQuotePaid: body.triggerOnQuotePaid === true,
    triggerOnDealCompleted: body.triggerOnDealCompleted === true,
    updatedAt: new Date(),
  };

  await getAdminDb()
    .doc(`subAccounts/${subAccountId}`)
    .set(
      { googleReviewConfig: cfg, updatedAt: FieldValue.serverTimestamp() },
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

  await getAdminDb()
    .doc(`subAccounts/${subAccountId}`)
    .set(
      { googleReviewConfig: null, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );

  return NextResponse.json({ ok: true });
}

function clampCooldown(v: number | undefined): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    return DEFAULT_REVIEW_COOLDOWN_DAYS;
  }
  return Math.max(0, Math.min(3650, Math.round(v)));
}
