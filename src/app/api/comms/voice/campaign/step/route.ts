import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  publishCallback,
  qstashIsConfigured,
  verifyQStashSignature,
} from "@/lib/automations/qstash";
import { getAgentProfile, getChannelConfig } from "@/lib/comms/ai/agent";
import { createOutboundCall, vapiIsConfigured } from "@/lib/comms/voice/vapi";
import {
  checkOutboundCompliance,
  type OutboundComplianceCode,
} from "@/lib/comms/voice/outbound-compliance";
import type {
  VoiceCampaignDoc,
  VoiceCampaignRecipientDoc,
  VoiceCampaignSkipReason,
} from "@/types";
import type { Contact } from "@/types/contacts";

export const dynamic = "force-dynamic";

interface StepBody {
  campaignId?: string;
  contactId?: string;
}

// Backstop against an endless reschedule loop; window deferrals normally
// happen once or twice.
const MAX_ATTEMPTS = 8;

// Codes that mean "try later" (reschedule) rather than skip.
const DEFERRABLE: ReadonlySet<OutboundComplianceCode> = new Set([
  "outside_window",
  "rate_limited",
]);

/**
 * Per-recipient bulk-call step, a QStash callback from the send route.
 * Upstash-Signature is the auth (route is in PUBLIC_PATH_PATTERNS). After the
 * compliance gate: allowed places the call, window/rate blocks republish with
 * the gate's delay, anything else skips with a reason. Returns 200 except on
 * infra 503s so one bad row can't retry-storm the campaign.
 */
export async function POST(request: Request) {
  if (!qstashIsConfigured()) {
    return NextResponse.json(
      { error: "QStash is not configured." },
      { status: 503 },
    );
  }
  if (!vapiIsConfigured()) {
    // Creds vanished after fan-out; let QStash retry instead of burning the row.
    return NextResponse.json(
      { error: "Voice isn't configured." },
      { status: 503 },
    );
  }

  const signature = request.headers.get("upstash-signature");
  if (!signature) {
    return NextResponse.json(
      { error: "Missing Upstash-Signature header" },
      { status: 401 },
    );
  }
  const rawBody = await request.text();
  if (!(await verifyQStashSignature(signature, rawBody))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: StepBody;
  try {
    payload = JSON.parse(rawBody) as StepBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { campaignId, contactId } = payload;
  if (typeof campaignId !== "string" || typeof contactId !== "string") {
    return NextResponse.json(
      { error: "campaignId and contactId are required" },
      { status: 400 },
    );
  }

  const db = getAdminDb();
  const campaignRef = db.collection("voiceCampaigns").doc(campaignId);
  const recRef = campaignRef.collection("recipients").doc(contactId);

  const [campaignSnap, recSnap] = await Promise.all([
    campaignRef.get(),
    recRef.get(),
  ]);
  if (!campaignSnap.exists || !recSnap.exists) {
    return NextResponse.json({ ok: true, ignored: "missing" });
  }
  const campaign = campaignSnap.data() as VoiceCampaignDoc;
  const rec = recSnap.data() as VoiceCampaignRecipientDoc;

  // Settled rows are never re-processed.
  if (rec.status !== "queued") {
    return NextResponse.json({ ok: true, ignored: "already_settled" });
  }

  // Operator stopped the campaign. The cancel route batch-skips queued rows;
  // this catches a callback that raced in before that write.
  if (campaign.status === "cancelled") {
    await skip(recRef, campaignRef, "cancelled");
    return NextResponse.json({ ok: true, status: "skipped", reason: "cancelled" });
  }

  if (campaign.status === "queued") {
    await campaignRef.update({
      status: "calling",
      startedAt: FieldValue.serverTimestamp(),
    });
  }

  // Live read: opt-out may have changed since fan-out.
  const contactSnap = await db.collection("contacts").doc(contactId).get();
  if (!contactSnap.exists) {
    await skip(recRef, campaignRef, "contact_missing");
    await maybeComplete(campaignRef);
    return NextResponse.json({ ok: true, status: "skipped" });
  }
  const contact = {
    id: contactSnap.id,
    ...(contactSnap.data() as Omit<Contact, "id">),
  };

  const channel = await getChannelConfig(campaign.subAccountId, "voice");
  const voice = channel?.voice ?? null;
  if (!voice || voice.outboundEnabled !== true || !voice.vapiAssistantId || !voice.vapiPhoneNumberId) {
    // Channel turned off or unprovisioned mid-campaign: stop dialing.
    await skip(recRef, campaignRef, "scrub_blocked");
    await maybeComplete(campaignRef);
    return NextResponse.json({ ok: true, status: "skipped" });
  }

  const profile = await getAgentProfile(campaign.subAccountId);
  const agentTimezone =
    profile?.timezone || voice.outboundWindow?.timezone || "UTC";

  const compliance = await checkOutboundCompliance({
    subAccountId: campaign.subAccountId,
    contact,
    voice,
    agentTimezone,
    consentAck: campaign.consentAck === true,
  });

  if (!compliance.allowed) {
    const code = compliance.code;
    if (code && DEFERRABLE.has(code) && rec.attempts < MAX_ATTEMPTS) {
      const delay =
        code === "outside_window"
          ? Math.max(60, compliance.retryAfterSec ?? 3600)
          : 30; // rate_limited: short backoff
      await recRef.update({ attempts: FieldValue.increment(1) });
      await publishCallback({
        pathname: "/api/comms/voice/campaign/step",
        body: { campaignId, contactId },
        delaySeconds: delay,
        // New dedup id so QStash treats the reschedule as a new message.
        deduplicationId: `vcamp_${campaignId}_${contactId}_a${rec.attempts + 1}`,
      });
      return NextResponse.json({ ok: true, status: "deferred", code });
    }
    const reason: VoiceCampaignSkipReason =
      code && DEFERRABLE.has(code)
        ? "window_unreached"
        : ((code as VoiceCampaignSkipReason | undefined) ?? "scrub_blocked");
    await skip(recRef, campaignRef, reason);
    await maybeComplete(campaignRef);
    return NextResponse.json({ ok: true, status: "skipped", code });
  }

  const customerNumber = compliance.e164 ?? contact.phone;
  let callId: string;
  let callControlUrl: string | null = null;
  try {
    const result = await createOutboundCall({
      assistantId: voice.vapiAssistantId,
      phoneNumberId: voice.vapiPhoneNumberId,
      customerNumber,
      contactId,
      campaignId,
      firstMessage: voice.outboundFirstMessage,
    });
    callId = result.callId;
    callControlUrl = result.controlUrl;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Vapi call failed";
    await recRef.update({
      status: "failed",
      error: msg,
      settledAt: FieldValue.serverTimestamp(),
      attempts: FieldValue.increment(1),
    });
    await campaignRef.update({
      "totals.failed": FieldValue.increment(1),
      "totals.queued": FieldValue.increment(-1),
    });
    await maybeComplete(campaignRef);
    return NextResponse.json({ ok: true, status: "failed" });
  }

  // Placeholder so the gate's caps count it and the console shows it (same
  // as the single-call route).
  try {
    await db
      .doc(`subAccounts/${campaign.subAccountId}/voiceCalls/${callId}`)
      .set(
        {
          id: callId,
          agencyId: campaign.agencyId,
          subAccountId: campaign.subAccountId,
          callId,
          direction: "outbound",
          callerPhone: customerNumber,
          toPhone: null,
          durationSec: 0,
          summary: null,
          endedReason: null,
          contactId,
          contactCreated: false,
          callbackRequested: false,
          capturedName: null,
          capturedEmail: null,
          capturedPhone: null,
          taskId: null,
          escalationEmailSent: false,
          transcript: [],
          liveStatus: "queued",
          liveStatusAt: FieldValue.serverTimestamp(),
          campaignId,
          consentAck: true,
          errors: [],
          createdAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
  } catch (err) {
    console.warn("[voice/campaign/step] voiceCalls placeholder failed", err);
  }

  await recRef.update({
    status: "called",
    callId,
    callControlUrl,
    settledAt: FieldValue.serverTimestamp(),
    attempts: FieldValue.increment(1),
  });
  await campaignRef.update({
    "totals.called": FieldValue.increment(1),
    "totals.queued": FieldValue.increment(-1),
  });

  // Read by the audience resolver for "don't re-call recently contacted".
  await db
    .collection("contacts")
    .doc(contactId)
    .update({
      lastOutboundCallAt: FieldValue.serverTimestamp(),
      lastOutboundCampaignId: campaignId,
    })
    .catch((err) =>
      console.warn("[voice/campaign/step] contact stamp failed", err),
    );

  await db
    .collection("contacts")
    .doc(contactId)
    .collection("activities")
    .add({
      type: "voice_call_initiated",
      content: "Outbound AI call placed (campaign)",
      createdBy: "voice-campaign",
      meta: { callId, campaignId },
      createdAt: FieldValue.serverTimestamp(),
    })
    .catch((err) =>
      console.warn("[voice/campaign/step] activity write failed", err),
    );

  await maybeComplete(campaignRef);
  return NextResponse.json({ ok: true, status: "called", callId });
}

async function skip(
  recRef: FirebaseFirestore.DocumentReference,
  campaignRef: FirebaseFirestore.DocumentReference,
  reason: VoiceCampaignSkipReason,
): Promise<void> {
  await recRef.update({
    status: "skipped",
    skippedReason: reason,
    settledAt: FieldValue.serverTimestamp(),
    attempts: FieldValue.increment(1),
  });
  await campaignRef.update({
    "totals.skipped": FieldValue.increment(1),
    "totals.queued": FieldValue.increment(-1),
  });
}

// Transaction so two final rows settling at once can't both flip it.
async function maybeComplete(
  campaignRef: FirebaseFirestore.DocumentReference,
): Promise<void> {
  await getAdminDb().runTransaction(async (tx) => {
    const snap = await tx.get(campaignRef);
    if (!snap.exists) return;
    const data = snap.data() as VoiceCampaignDoc;
    if (
      data.status === "completed" ||
      data.status === "failed" ||
      data.status === "cancelled"
    )
      return;
    if ((data.totals?.queued ?? 0) <= 0) {
      tx.update(campaignRef, {
        status: "completed",
        completedAt: FieldValue.serverTimestamp(),
      });
    }
  });
}
