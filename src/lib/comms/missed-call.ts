import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { emitWebhookEvent } from "@/lib/api/webhooks/dispatch";
import { reconcileContactFromCapture } from "@/lib/comms/ai/capture";
import { sendSmsForSubAccount } from "@/lib/comms/twilio";
import { smsSendBlock } from "@/lib/comms/sms-consent";
import { upsertConversationForMessage } from "@/lib/server/conversations-service";
import type { MissedCallConfig, SubAccountDoc } from "@/types";
import type { Contact } from "@/types/contacts";

/**
 * Missed Call Text Back. The number's Voice URL points at
 * /api/webhooks/twilio/voice, which forwards to the business's real phone; an
 * unanswered forward hits /api/webhooks/twilio/voice/status, which calls
 * handleMissedCall to text the caller.
 *
 * Only active with dedicated Twilio on, the agency gate on and
 * `twilioConfig.missedCall.enabled` (same checks as the settings route). Never
 * touches the SMS inbound path or the Vapi voice pipeline.
 */

export const DEFAULT_MCTB_MESSAGE =
  "Sorry we missed your call! Reply to this text and we'll help you right away.";
export const DEFAULT_MCTB_RING_TIMEOUT_SEC = 20;

/** Dial statuses meaning nobody picked up. */
const MISSED_STATUSES = new Set(["no-answer", "busy", "failed", "canceled"]);

export function isMissedDialStatus(status: string | undefined | null): boolean {
  return !!status && MISSED_STATUSES.has(status.trim().toLowerCase());
}

export function normalisePhone(s: string): string {
  let cleaned = s.trim().replace(/[\s\-()]/g, "");
  if (cleaned.startsWith("00")) cleaned = "+" + cleaned.slice(2);
  return cleaned;
}

export interface VoiceRoute {
  subAccountId: string;
  agencyId: string;
  authToken: string;
  subAccount: SubAccountDoc;
  missedCall: MissedCallConfig;
}

/**
 * Owning sub-account for an inbound number, or null unless dedicated Twilio,
 * the agency gate and MCTB are all on. A number with MCTB turned off but its
 * Voice URL not yet repointed is treated as unrouted.
 */
export async function resolveVoiceRoute(
  toNumber: string,
): Promise<VoiceRoute | null> {
  if (!toNumber) return null;
  const normalisedTo = normalisePhone(toNumber);

  const snap = await getAdminDb()
    .collection("subAccounts")
    .where("twilioConfig.fromNumber", "==", normalisedTo)
    .where("twilioConfig.enabled", "==", true)
    .limit(1)
    .get();
  if (snap.empty) return null;

  const doc = snap.docs[0];
  const sa = { id: doc.id, ...(doc.data() as Omit<SubAccountDoc, "id">) };
  const cfg = sa.twilioConfig;
  const mctb = cfg?.missedCall ?? null;
  if (
    sa.missedCallTextBackEnabledByAgency !== true ||
    !mctb?.enabled ||
    !cfg?.authToken ||
    !mctb.forwardTo
  ) {
    return null;
  }

  return {
    subAccountId: doc.id,
    agencyId: sa.agencyId,
    authToken: cfg.authToken,
    subAccount: sa,
    missedCall: mctb,
  };
}

/**
 * Small self-contained tag set so a new caller with no name never sees a broken
 * template: {{contact.firstName}}/{{firstName}}, {{workspace.name}}/{{businessName}}.
 * Unknown tags collapse to "".
 */
export function renderMissedCallMessage(
  body: string,
  ctx: { firstName: string; businessName: string },
): string {
  return body
    .replace(/\{\{\s*(contact\.)?firstName\s*\}\}/gi, ctx.firstName)
    .replace(/\{\{\s*(workspace\.name|businessName)\s*\}\}/gi, ctx.businessName)
    .replace(/\{\{[^}]*\}\}/g, "") // drop unknown tags
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** First claim wins and returns true; Twilio retries get false, so we never double-text. Admin SDK only. */
async function claimCall(
  subAccountId: string,
  callSid: string,
): Promise<boolean> {
  const ref = getAdminDb()
    .doc(`subAccounts/${subAccountId}/missedCallClaims/${callSid}`);
  try {
    return await getAdminDb().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) return false;
      tx.set(ref, { callSid, createdAt: FieldValue.serverTimestamp() });
      return true;
    });
  } catch (err) {
    console.warn("[mctb] claim transaction failed", err);
    // Fail open: a rare double-text beats dropping the text-back on a Firestore blip.
    return true;
  }
}

export interface HandleMissedCallResult {
  handled: boolean;
  reason?: string;
  contactId?: string;
  smsSid?: string;
}

/**
 * Dedup, match the caller to a contact (phone-first, create if new), respect
 * SMS opt-out, send, save the message row + inbox index, log a `missed_call`
 * activity. Best-effort; the webhook always 200s to Twilio.
 */
export async function handleMissedCall(input: {
  route: VoiceRoute;
  from: string;
  callSid: string;
}): Promise<HandleMissedCallResult> {
  const { route, from, callSid } = input;
  const { subAccountId, agencyId, subAccount, missedCall } = route;

  if (!from) return { handled: false, reason: "no_caller" };

  // One text-back per call.
  if (callSid) {
    const fresh = await claimCall(subAccountId, callSid);
    if (!fresh) return { handled: false, reason: "already_handled" };
  }

  const db = getAdminDb();

  // Phone is always known here.
  const reconciled = await reconcileContactFromCapture({
    agencyId,
    subAccountId,
    existingContactId: null,
    pageUrl: null,
    source: "voice",
    matchStrategy: "phone-first",
    capture: { name: null, email: null, phone: from },
  });
  if (!reconciled) return { handled: false, reason: "reconcile_failed" };
  const contactId = reconciled.contactId;

  // For opt-out and merge tags.
  const contactSnap = await db.doc(`contacts/${contactId}`).get();
  const contact = contactSnap.data() as Contact | undefined;
  const firstName = (contact?.name ?? "").trim().split(/\s+/)[0] ?? "";

  // The miss itself is the event, whatever happens to the text-back. Emitted
  // once per call (the claim already deduped retries).
  void emitWebhookEvent({
    subAccountId,
    agencyId,
    mode: "live",
    type: "call.missed",
    payload: {
      call: {
        object: "missed_call",
        contact_id: contactId,
        contact_name: contact?.name ?? "",
        from,
        call_sid: callSid || null,
      },
    },
  });

  // Log the miss even when opt-out suppresses the text.
  const logActivity = async (content: string) => {
    try {
      await db.collection(`contacts/${contactId}/activities`).add({
        type: "missed_call",
        content,
        createdBy: "twilio_voice",
        meta: { kind: "missed_call", callSid, from },
        createdAt: FieldValue.serverTimestamp(),
      });
    } catch (err) {
      console.warn("[mctb] activity write failed", err);
    }
  };

  if (contact && smsSendBlock(contact)) {
    await logActivity(
      `Missed call from ${from}. Text-back suppressed — contact is opted out of SMS.`,
    );
    return { handled: true, reason: "opted_out", contactId };
  }

  const bodyText = renderMissedCallMessage(
    missedCall.messageBody?.trim() || DEFAULT_MCTB_MESSAGE,
    { firstName, businessName: subAccount.name ?? "" },
  );

  let smsSid: string | undefined;
  try {
    const sent = await sendSmsForSubAccount({
      subAccountId,
      subAccount,
      to: from,
      body: bodyText,
    });
    smsSid = sent.sid;
  } catch (err) {
    console.error("[mctb] text-back send failed", err);
    await logActivity(`Missed call from ${from}. Auto-text failed to send.`);
    return { handled: false, reason: "send_failed", contactId };
  }

  // Message row for the contact's Messages tab, plus the inbox index.
  try {
    const msgId = smsSid || db.collection("contacts").doc().id;
    await db
      .doc(`contacts/${contactId}/messages/${msgId}`)
      .set(
        {
          agencyId,
          subAccountId,
          contactId,
          direction: "outbound",
          status: "sent",
          body: bodyText,
          from: subAccount.twilioConfig?.fromNumber ?? "",
          to: from,
          twilioMessageSid: smsSid ?? null,
          sentByUid: null,
          error: null,
          readAt: null,
          createdAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    await upsertConversationForMessage({
      contactId,
      subAccountId,
      agencyId,
      contactName: contact?.name ?? "",
      contactPhone: contact?.phone ?? from,
      channel: "sms",
      direction: "outbound",
      body: bodyText,
    });
  } catch (err) {
    console.warn("[mctb] message-row / inbox write failed", err);
  }

  await logActivity(
    `Missed call from ${from}. Auto-text sent: "${bodyText}"`,
  );

  return { handled: true, contactId, smsSid };
}
