import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import twilio from "twilio";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  dialerActivityId,
  formatCallDuration,
  validateDialerSignature,
} from "@/lib/comms/dialer";
import type { SubAccountDoc } from "@/types";
import { recordCounter } from "@/lib/server/usage-meter";
import { runAfterResponse } from "@/lib/server/after-response";

export const dynamic = "force-dynamic";

/**
 * Dialer <Dial action> callback, fired when the dialed leg ends. Updates the
 * `call_placed` activity (written by the TwiML route) with outcome, duration
 * and RecordingUrl if recording is on. `?contactId=` on the action URL is
 * covered by the signature (validateDialerSignature keeps the query).
 * Replies <Hangup/> so the operator's leg ends too.
 */

const OUTCOME_LABEL: Record<string, string> = {
  completed: "completed",
  answered: "completed",
  busy: "busy",
  "no-answer": "no answer",
  failed: "failed",
  canceled: "canceled",
};

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
  if (!authToken) return new NextResponse("Unknown sub-account", { status: 404 });
  if (!validateDialerSignature({ request, authToken, params })) {
    return new NextResponse("Invalid signature", { status: 403 });
  }

  const contactId = new URL(request.url).searchParams.get("contactId") ?? "";
  const callSid = params["CallSid"] ?? "";
  const dialStatus = params["DialCallStatus"] ?? "";
  const durationSec = Number(params["DialCallDuration"] ?? "0") || 0;
  const recordingUrl = params["RecordingUrl"] || null;

  if (contactId && callSid) {
    const outcome = OUTCOME_LABEL[dialStatus] ?? dialStatus ?? "ended";
    const content =
      outcome === "completed"
        ? `Phone call — ${formatCallDuration(durationSec)}`
        : `Phone call — ${outcome}`;
    try {
      const contactRef = db.collection("contacts").doc(contactId);
      const contactSnap = await contactRef.get();
      if (
        contactSnap.exists &&
        contactSnap.data()?.subAccountId === subAccountId
      ) {
        const activityRef = contactRef
          .collection("activities")
          .doc(dialerActivityId(callSid));
        // Transaction so a Twilio retry racing the first callback can't meter twice.
        const firstWithDuration = await db.runTransaction(async (tx) => {
          const existing = await tx.get(activityRef);
          tx.set(
            activityRef,
            {
              type: "call_placed",
              content,
              meta: {
                callSid,
                status: dialStatus || "ended",
                durationSec,
                // Twilio-hosted; opening it needs a Twilio login.
                ...(recordingUrl ? { recordingUrl } : {}),
              },
              // The timeline orders by createdAt, so backfill it if the TwiML write failed.
              ...(existing.exists
                ? {}
                : {
                    createdBy: "dialer",
                    createdAt: FieldValue.serverTimestamp(),
                  }),
            },
            { merge: true },
          );
          return typeof existing.data()?.meta?.durationSec !== "number";
        });
        if (firstWithDuration && durationSec > 0) {
          runAfterResponse(() =>
            recordCounter({ subAccountId, counter: "softphoneSeconds", qty: durationSec }),
          );
        }
      }
    } catch (err) {
      console.warn("[dialer/status] activity update failed", err);
    }
  }

  const res = new twilio.twiml.VoiceResponse();
  res.hangup();
  return new NextResponse(res.toString(), {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}
