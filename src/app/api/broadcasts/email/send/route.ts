import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminAuth, getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { loadEffectiveTerritoryScope } from "@/lib/auth/territory-filter";
import { emailIsConfigured } from "@/lib/comms/resend";
import { publishCallback, qstashIsConfigured } from "@/lib/automations/qstash";
import { resolveMergeTags, validateEmailBody } from "@/lib/automations/merge-tags";
import { resolveAudience } from "@/lib/broadcasts/audience";
import type {
  BroadcastAudienceFilter,
  BroadcastDoc,
  BroadcastSendDoc,
  MessageTemplateDoc,
} from "@/types";

export const dynamic = "force-dynamic";

interface SendBody {
  subAccountId?: string;
  templateId?: string;
  audienceFilter?: BroadcastAudienceFilter;
}

/**
 * QStash fan-out rate: 5/sec, under Resend's free-tier 10 req/sec with room
 * for one-off sends. One delayed message per recipient, so a batch drains in
 * about audienceSize / SEND_RATE seconds. Fan-out (rather than Resend
 * Broadcasts) keeps per-contact merge tags.
 */
const SEND_RATE_PER_SECOND = 5;
const DELAY_BETWEEN_SENDS_MS = 1000 / SEND_RATE_PER_SECOND;

/** Hard cap on per-broadcast audience size to prevent runaway sends. */
const MAX_AUDIENCE_SIZE = 25_000;

export async function POST(request: Request) {
  if (!emailIsConfigured()) {
    return NextResponse.json(
      { error: "Email is not configured on this deployment." },
      { status: 503 },
    );
  }
  if (!qstashIsConfigured()) {
    return NextResponse.json(
      { error: "QStash is not configured — bulk send needs the queue." },
      { status: 503 },
    );
  }

  let payload: SendBody;
  try {
    payload = (await request.json()) as SendBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const subAccountId = payload.subAccountId?.trim();
  const templateId = payload.templateId?.trim();
  const audienceFilter = payload.audienceFilter;

  if (!subAccountId || !templateId || !audienceFilter) {
    return NextResponse.json(
      { error: "subAccountId, templateId, and audienceFilter are required" },
      { status: 400 },
    );
  }
  if (
    audienceFilter.kind !== "all" &&
    audienceFilter.kind !== "tag" &&
    audienceFilter.kind !== "pipeline_stage" &&
    audienceFilter.kind !== "broadcast_unopened"
  ) {
    return NextResponse.json(
      {
        error:
          "audienceFilter.kind must be 'all', 'tag', 'pipeline_stage', or 'broadcast_unopened'",
      },
      { status: 400 },
    );
  }

  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const db = getAdminDb();

  // Resend to unopened: the source must be this sub-account's finished broadcast.
  let resendOfBroadcastId: string | null = null;
  if (audienceFilter.kind === "broadcast_unopened") {
    const sourceId =
      typeof audienceFilter.broadcastId === "string"
        ? audienceFilter.broadcastId.trim()
        : "";
    const sourceSnap = sourceId
      ? await db.collection("broadcasts").doc(sourceId).get()
      : null;
    const source = sourceSnap?.exists ? (sourceSnap.data() as BroadcastDoc) : null;
    if (!source || source.subAccountId !== subAccountId) {
      return NextResponse.json(
        { error: "Source broadcast not found" },
        { status: 404 },
      );
    }
    if (source.status !== "completed") {
      return NextResponse.json(
        { error: "Wait until the original broadcast has finished sending." },
        { status: 400 },
      );
    }
    resendOfBroadcastId = sourceId;
  }

  // Agency gate, set only by the agency owner. Missing field = locked.
  const subSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  if (!subSnap.exists) {
    return NextResponse.json(
      { error: "Sub-account not found" },
      { status: 404 },
    );
  }
  if (subSnap.data()?.broadcastsEnabledByAgency !== true) {
    return NextResponse.json(
      {
        error:
          "Broadcasts are disabled for this sub-account. Your agency administrator can enable them from Manage in the agency sub-accounts list.",
      },
      { status: 403 },
    );
  }

  // Template must exist, be email, and contain {{unsubscribeLink}}.
  const templateSnap = await db
    .collection("message_templates")
    .doc(templateId)
    .get();
  if (!templateSnap.exists) {
    return NextResponse.json({ error: "Template not found" }, { status: 404 });
  }
  const template = templateSnap.data() as MessageTemplateDoc;
  if (template.subAccountId !== subAccountId) {
    return NextResponse.json(
      { error: "Template belongs to a different sub-account" },
      { status: 403 },
    );
  }
  if (template.type !== "email") {
    return NextResponse.json(
      { error: "Template is not an email template" },
      { status: 400 },
    );
  }
  const bodyValidation = validateEmailBody(template.body);
  if (bodyValidation) {
    return NextResponse.json({ error: bodyValidation }, { status: 400 });
  }

  // Scoped collaborators only reach their territories; null = unscoped.
  const scope = await loadEffectiveTerritoryScope(access);
  const audience = await resolveAudience(
    subAccountId,
    resendOfBroadcastId
      ? { kind: "broadcast_unopened", broadcastId: resendOfBroadcastId }
      : audienceFilter,
    scope.enforce ? (scope.ids ?? []) : null,
  );
  if (audience.recipients.length === 0) {
    return NextResponse.json(
      {
        error:
          "Audience is empty after pre-flight (no contacts match, or all are opted-out / missing email).",
        skipped: audience.skipped.length,
      },
      { status: 400 },
    );
  }
  if (audience.recipients.length > MAX_AUDIENCE_SIZE) {
    return NextResponse.json(
      {
        error: `Audience size ${audience.recipients.length} exceeds the per-broadcast cap of ${MAX_AUDIENCE_SIZE}. Narrow the filter and try again.`,
      },
      { status: 400 },
    );
  }

  let createdByName = access.email;
  try {
    const u = await getAdminAuth().getUser(access.uid);
    createdByName = u.displayName || u.email || access.email;
  } catch {
    // Fall back to the email.
  }

  // List-view label only; per-send rendering still resolves merge tags.
  const subjectPreview = (template.subject ?? "")
    .slice(0, 200);

  const agencyId = templateSnap.data()?.agencyId as string;
  const broadcastRef = db.collection("broadcasts").doc();

  const broadcast: Omit<BroadcastDoc, "id"> = {
    agencyId,
    subAccountId,
    channel: "email",
    templateId,
    templateName: template.name,
    subjectPreview: resolveMergeTags(subjectPreview, {
      contact: { name: "", email: "", phone: "" },
      owner: { displayName: "", email: "" },
      workspace: { name: "" },
      bookingLink: "",
      unsubscribeLink: "",
    }),
    audienceFilter,
    status: "queued",
    totals: {
      audienceSize: audience.recipients.length + audience.skipped.length,
      queued: audience.recipients.length,
      sent: 0,
      skipped: audience.skipped.length,
      failed: 0,
    },
    createdByUid: access.uid,
    createdBy: { displayName: createdByName, email: access.email },
    createdAt: FieldValue.serverTimestamp() as unknown as null,
    startedAt: null,
    completedAt: null,
    errorMessage: null,
    resendOfBroadcastId,
  };
  await broadcastRef.set({ id: broadcastRef.id, ...broadcast });

  // Per-send rows, 500 per batch (Firestore's limit).
  const sendsCol = broadcastRef.collection("sends");
  const recipientsToQueue = audience.recipients;
  for (let i = 0; i < recipientsToQueue.length; i += 500) {
    const slice = recipientsToQueue.slice(i, i + 500);
    const batch = db.batch();
    for (const contact of slice) {
      const sendRef = sendsCol.doc(contact.id);
      const sendDoc: Omit<BroadcastSendDoc, "id"> = {
        broadcastId: broadcastRef.id,
        agencyId,
        subAccountId,
        contactId: contact.id,
        toEmail: contact.email,
        toName: contact.name,
        status: "queued",
        skippedReason: null,
        resendMessageId: null,
        error: null,
        attempts: 0,
        queuedAt: FieldValue.serverTimestamp() as unknown as null,
        sentAt: null,
      };
      batch.set(sendRef, { id: contact.id, ...sendDoc });
    }
    await batch.commit();
  }

  // Terminal rows for skipped contacts so the detail page shows the reason.
  const skippedToWrite = audience.skipped;
  for (let i = 0; i < skippedToWrite.length; i += 500) {
    const slice = skippedToWrite.slice(i, i + 500);
    const batch = db.batch();
    for (const { contact, reason } of slice) {
      const sendRef = sendsCol.doc(contact.id);
      const sendDoc: Omit<BroadcastSendDoc, "id"> = {
        broadcastId: broadcastRef.id,
        agencyId,
        subAccountId,
        contactId: contact.id,
        toEmail: contact.email,
        toName: contact.name,
        status: "skipped",
        skippedReason: reason,
        resendMessageId: null,
        error: null,
        attempts: 0,
        queuedAt: FieldValue.serverTimestamp() as unknown as null,
        sentAt: FieldValue.serverTimestamp() as unknown as null,
      };
      batch.set(sendRef, { id: contact.id, ...sendDoc });
    }
    await batch.commit();
  }

  // One staggered QStash message per recipient; the step route sends.
  let queuedCount = 0;
  let publishFailures = 0;
  for (let i = 0; i < recipientsToQueue.length; i++) {
    const contact = recipientsToQueue[i];
    const delayMs = i * DELAY_BETWEEN_SENDS_MS;
    const result = await publishCallback({
      pathname: "/api/broadcasts/email/step",
      body: { broadcastId: broadcastRef.id, contactId: contact.id },
      // Delay is in seconds; round up so adjacent sends don't share a second.
      delaySeconds: Math.ceil(delayMs / 1000),
      // Dedup id so a double-submitted Send can't publish duplicates.
      deduplicationId: `bcast_${broadcastRef.id}_${contact.id}`,
    });
    if (result) {
      queuedCount += 1;
    } else {
      publishFailures += 1;
    }
  }

  // All publishes failed (e.g. bad NEXT_PUBLIC_APP_URL): mark failed rather
  // than leave it stuck queued. Partial failures are tolerated.
  if (queuedCount === 0 && publishFailures > 0) {
    await broadcastRef.update({
      status: "failed",
      errorMessage: "Every QStash publish failed. Check NEXT_PUBLIC_APP_URL.",
      completedAt: FieldValue.serverTimestamp(),
    });
    return NextResponse.json(
      { error: "Failed to schedule any sends. Check QStash configuration." },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    broadcastId: broadcastRef.id,
    queued: queuedCount,
    skipped: audience.skipped.length,
    publishFailures,
  });
}
