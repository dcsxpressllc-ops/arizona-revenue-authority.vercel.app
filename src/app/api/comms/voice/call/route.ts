import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { requireContactAccessible, requireUid } from "@/lib/comms/route-auth";
import { getAgentProfile, getChannelConfig } from "@/lib/comms/ai/agent";
import { vapiIsConfigured, createOutboundCall } from "@/lib/comms/voice/vapi";
import { checkOutboundCompliance } from "@/lib/comms/voice/outbound-compliance";
import type { SubAccountDoc } from "@/types";

type Body = { contactId?: string; consentAck?: boolean };

/**
 * Operator click-to-call: place an outbound AI voice call to a contact.
 * Gates in order: contact access, agency gate (403), voice.outboundEnabled
 * (403), Vapi configured and inbound assistant/number provisioned (503/400),
 * then the compliance gate (opt-out, consent, window, caps), which returns
 * 422 with a `code` before any Vapi minutes are spent. Reuses the inbound
 * assistant and number.
 */
export async function POST(request: Request) {
  const auth = requireUid(request);
  if (auth instanceof NextResponse) return auth;

  let payload: Body;
  try {
    payload = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const contactId = payload.contactId?.trim();
  if (!contactId) {
    return NextResponse.json(
      { error: "contactId is required" },
      { status: 400 },
    );
  }

  const contact = await requireContactAccessible(auth.uid, contactId);
  if (contact instanceof NextResponse) return contact;

  const db = getAdminDb();

  const saSnap = await db.doc(`subAccounts/${contact.subAccountId}`).get();
  const subAccount = saSnap.exists ? (saSnap.data() as SubAccountDoc) : null;
  if (subAccount?.outboundVoiceEnabledByAgency !== true) {
    return NextResponse.json(
      {
        error:
          "Outbound calling is disabled for this workspace. Ask your agency owner to enable it.",
      },
      { status: 403 },
    );
  }

  const channel = await getChannelConfig(contact.subAccountId, "voice");
  const voice = channel?.voice ?? null;
  if (!voice || voice.outboundEnabled !== true) {
    return NextResponse.json(
      { error: "Outbound calling isn't enabled in the Voice settings." },
      { status: 403 },
    );
  }

  if (!vapiIsConfigured()) {
    return NextResponse.json(
      { error: "Voice calling isn't configured on this deployment." },
      { status: 503 },
    );
  }
  if (!voice.vapiAssistantId || !voice.vapiPhoneNumberId) {
    return NextResponse.json(
      {
        error:
          "Enable the Voice channel first so the calling number is provisioned.",
      },
      { status: 400 },
    );
  }

  const profile = await getAgentProfile(contact.subAccountId);
  const agentTimezone =
    profile?.timezone || voice.outboundWindow?.timezone || "UTC";
  const compliance = await checkOutboundCompliance({
    subAccountId: contact.subAccountId,
    contact,
    voice,
    agentTimezone,
    consentAck: payload.consentAck === true,
  });
  if (!compliance.allowed) {
    return NextResponse.json(
      {
        ok: false,
        code: compliance.code,
        error: compliance.reason,
        retryAfterSec: compliance.retryAfterSec ?? null,
      },
      { status: 422 },
    );
  }

  const customerNumber = compliance.e164 ?? contact.phone;

  let callId: string;
  try {
    const result = await createOutboundCall({
      assistantId: voice.vapiAssistantId,
      phoneNumberId: voice.vapiPhoneNumberId,
      customerNumber,
      contactId,
      firstMessage: voice.outboundFirstMessage,
    });
    callId = result.callId;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to place the call";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }

  // Placeholder written now so the per-number/daily caps count this call and
  // the console shows it; the end-of-call webhook merges in the rest.
  // callerPhone is the external party (as for inbound) so the frequency
  // query works in both directions.
  try {
    await db
      .doc(`subAccounts/${contact.subAccountId}/voiceCalls/${callId}`)
      .set(
        {
          id: callId,
          agencyId: contact.agencyId,
          subAccountId: contact.subAccountId,
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
          // Audit: who placed it, and that consent was acknowledged.
          initiatedByUid: auth.uid,
          consentAck: true,
          errors: [],
          createdAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
  } catch (err) {
    console.warn("[voice/call] placeholder doc write failed", err);
  }

  try {
    await db
      .collection("contacts")
      .doc(contactId)
      .collection("activities")
      .add({
        type: "voice_call_initiated",
        content: "Outbound AI call placed",
        createdBy: auth.uid,
        meta: { callId },
        createdAt: FieldValue.serverTimestamp(),
      });
  } catch (err) {
    console.warn("[voice/call] activity write failed", err);
  }

  // Counts as a recent outbound touch for cross-campaign suppression
  // (campaign id null for one-off calls).
  await db
    .collection("contacts")
    .doc(contactId)
    .update({
      lastOutboundCallAt: FieldValue.serverTimestamp(),
      lastOutboundCampaignId: null,
    })
    .catch((err) => console.warn("[voice/call] contact stamp failed", err));

  return NextResponse.json({ ok: true, callId });
}
