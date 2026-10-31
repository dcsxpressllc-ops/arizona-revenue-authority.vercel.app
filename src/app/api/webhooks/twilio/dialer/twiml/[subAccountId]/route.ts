import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import twilio from "twilio";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  dialerActivityId,
  dialerEnabled,
  dialerStatusUrl,
  uidFromClientAddress,
  validateDialerSignature,
} from "@/lib/comms/dialer";
import type { Contact } from "@/types/contacts";
import type { SubAccountDoc } from "@/types";

export const dynamic = "force-dynamic";

/**
 * TwiML App voice URL for the dialer. Twilio POSTs here when the browser
 * Device calls `device.connect({ params: { contactId } })`; we reply with
 * what to dial.
 *
 * Signature is checked with the sub-account's authToken (the TwiML App is
 * on their account). The number is resolved server-side from the contact,
 * never chosen by the browser. Before dialing: dialerConfig.enabled, the
 * contact belongs here and has a phone, and voiceOptedOut (spoken refusal +
 * hangup).
 *
 * Writes the `call_placed` activity (id `dialer_<CallSid>`) up front; the
 * <Dial action> callback fills in outcome, duration and recording.
 */

function twiml(res: InstanceType<typeof twilio.twiml.VoiceResponse>) {
  return new NextResponse(res.toString(), {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}

function rejection(message: string) {
  const res = new twilio.twiml.VoiceResponse();
  res.say(message);
  res.hangup();
  return twiml(res);
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ subAccountId: string }> },
) {
  const { subAccountId } = await ctx.params;

  const raw = await request.text();
  const params = Object.fromEntries(new URLSearchParams(raw).entries());

  const db = getAdminDb();
  const sub = (
    await db.doc(`subAccounts/${subAccountId}`).get()
  ).data() as SubAccountDoc | undefined;

  const authToken = sub?.twilioConfig?.authToken;
  if (!authToken) {
    return new NextResponse("Unknown sub-account", { status: 404 });
  }
  if (!validateDialerSignature({ request, authToken, params })) {
    return new NextResponse("Invalid signature", { status: 403 });
  }

  if (!dialerEnabled(sub)) {
    return rejection("The dialer is disabled for this workspace. Goodbye.");
  }
  const fromNumber = sub?.twilioConfig?.fromNumber;
  if (!fromNumber) {
    return rejection("No caller I D number is configured. Goodbye.");
  }

  const contactId = (params["contactId"] ?? "").trim();
  if (!contactId) {
    return rejection("No contact was specified for this call. Goodbye.");
  }
  const contactSnap = await db.collection("contacts").doc(contactId).get();
  const contact = contactSnap.data() as Contact | undefined;
  if (!contactSnap.exists || contact?.subAccountId !== subAccountId) {
    return rejection("That contact could not be found. Goodbye.");
  }
  if (!contact.phone) {
    return rejection("That contact has no phone number. Goodbye.");
  }
  if (contact.voiceOptedOut === true) {
    return rejection(
      "This contact has opted out of phone calls, so the call cannot be placed. Goodbye.",
    );
  }

  // Written now so the call shows the moment it dials.
  const callSid = params["CallSid"] ?? "";
  const uid = uidFromClientAddress(params["From"]);
  if (callSid) {
    try {
      await contactSnap.ref
        .collection("activities")
        .doc(dialerActivityId(callSid))
        .set({
          type: "call_placed",
          content: "Phone call — in progress",
          createdBy: uid ?? "dialer",
          meta: { callSid, status: "in-progress" },
          createdAt: FieldValue.serverTimestamp(),
        });
    } catch (err) {
      console.warn("[dialer/twiml] activity write failed", err);
    }
  }

  const res = new twilio.twiml.VoiceResponse();
  const dial = res.dial({
    callerId: fromNumber,
    answerOnBridge: true,
    action: dialerStatusUrl(subAccountId, contactId),
    method: "POST",
    ...(sub?.dialerConfig?.recordCalls === true
      ? { record: "record-from-answer-dual" as const }
      : {}),
  });
  dial.number(contact.phone);
  return twiml(res);
}
