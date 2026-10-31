import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  sendSmsForSubAccount,
  smsIsConfigured,
  subAccountTwilioIsConfigured,
  SmsRecipientUnsubscribedError,
} from "@/lib/comms/twilio";
import { requireContactAccessible, requireUid } from "@/lib/comms/route-auth";
import { smsSendBlock } from "@/lib/comms/sms-consent";
import { UsageQuotaExceededError } from "@/lib/server/usage-meter";
import { recordSend } from "@/lib/comms/usage";
import { upsertConversationForMessage } from "@/lib/server/conversations-service";
import type { SubAccountDoc } from "@/types";

type Body = { contactId?: string; body?: string; approvedDraft?: boolean };

/**
 * Send an SMS from a contact profile. Sub-accounts with their own Twilio
 * config send on those creds and get a message row so the chat thread
 * renders; others use the shared env-var sender (activity only, no message
 * row). A deployment can run dedicated-only with no env vars set.
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
  const body = payload.body?.trim();

  if (!contactId || !body) {
    return NextResponse.json(
      { error: "contactId and body are required" },
      { status: 400 },
    );
  }

  const contact = await requireContactAccessible(auth.uid, contactId);
  if (contact instanceof NextResponse) return contact;

  if (!contact.phone) {
    return NextResponse.json(
      { error: "This contact has no phone number." },
      { status: 400 },
    );
  }

  // Server-side opt-out gate. The composer disables itself, but that's no
  // endpoint guard, and carriers hold the registered brand responsible
  // however the message was sent.
  const smsBlock = smsSendBlock(contact);
  if (smsBlock) {
    return NextResponse.json(
      {
        error:
          smsBlock === "carrier_stop"
            ? "This contact has opted out of SMS (replied STOP). They must text START to opt back in."
            : "This contact declined SMS consent on a form.",
      },
      { status: 409 },
    );
  }

  const db = getAdminDb();
  const subAccountSnap = await db
    .doc(`subAccounts/${contact.subAccountId}`)
    .get();
  const subAccount = subAccountSnap.exists
    ? (subAccountSnap.data() as SubAccountDoc)
    : null;

  const dedicated = subAccountTwilioIsConfigured(subAccount?.twilioConfig);

  // Neither dedicated nor shared sender available.
  if (!dedicated && !smsIsConfigured()) {
    return NextResponse.json(
      { error: "SMS is not configured on this deployment." },
      { status: 503 },
    );
  }

  let sid: string;
  let mode: "shared" | "dedicated";
  let fromNumber: string;
  try {
    const result = await sendSmsForSubAccount({
      subAccountId: contact.subAccountId,
      subAccount,
      to: contact.phone,
      body,
    });
    sid = result.sid;
    mode = result.mode;
    fromNumber = result.from;
  } catch (err) {
    if (err instanceof UsageQuotaExceededError) {
      return NextResponse.json({ error: err.message }, { status: 429 });
    }
    if (err instanceof SmsRecipientUnsubscribedError) {
      // Authoritative carrier signal: record it so the next attempt is
      // refused up front (same shape as the inbound STOP webhook's write).
      try {
        await db.doc(`contacts/${contactId}`).update({
          smsOptedOut: true,
          updatedAt: FieldValue.serverTimestamp(),
        });
        await db
          .collection("contacts")
          .doc(contactId)
          .collection("activities")
          .add({
            type: "automation_step_skipped",
            content: `SMS refused by carrier — ${contact.phone} is unsubscribed (Twilio 21610).`,
            createdBy: auth.uid,
            meta: { kind: "sms_opt_out", word: "21610", optedOut: true },
            createdAt: FieldValue.serverTimestamp(),
          });
      } catch (recordErr) {
        console.warn("[sms/send] 21610 opt-out record failed", recordErr);
      }
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    const message = err instanceof Error ? err.message : "Failed to send SMS";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  const preview = body.length > 80 ? `${body.slice(0, 80)}…` : body;

  // Written in both modes; existing UIs read sms_sent activities.
  try {
    await db
      .collection("contacts")
      .doc(contactId)
      .collection("activities")
      .add({
        type: "sms_sent",
        content: `SMS: ${preview}`,
        createdBy: auth.uid,
        meta: { sid, mode },
        createdAt: FieldValue.serverTimestamp(),
      });
  } catch (err) {
    console.warn("[sms/send] activity write failed", err);
  }

  // Thread row, dedicated mode only. Doc id = MessageSid so a retry dedupes.
  if (mode === "dedicated") {
    try {
      await db
        .collection("contacts")
        .doc(contactId)
        .collection("messages")
        .doc(sid)
        .set({
          agencyId: contact.agencyId,
          subAccountId: contact.subAccountId,
          contactId,
          direction: "outbound",
          status: "sent",
          body,
          from: fromNumber,
          to: contact.phone,
          twilioMessageSid: sid,
          sentByUid: auth.uid,
          error: null,
          readAt: null,
          createdAt: FieldValue.serverTimestamp(),
        });
    } catch (err) {
      console.warn("[sms/send] message-row write failed", err);
    }

    await upsertConversationForMessage({
      contactId,
      subAccountId: contact.subAccountId,
      agencyId: contact.agencyId,
      contactName: contact.name ?? "",
      contactPhone: contact.phone,
      channel: "sms",
      direction: "outbound",
      body,
      pauseBot: true,
      // The inbox draft card sets this; it bills the AI reply once actually sent.
      approvedDraft: payload.approvedDraft === true,
    });
  }

  await recordSend(auth.uid, "sms");

  return NextResponse.json({ ok: true, sid, mode });
}
