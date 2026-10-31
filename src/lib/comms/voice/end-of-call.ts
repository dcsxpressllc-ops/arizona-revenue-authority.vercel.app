import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { reconcileContactFromCapture } from "@/lib/comms/ai/capture";
import { createCaptureFollowUp } from "@/lib/comms/ai/follow-up";
import { emitWebhookEvent } from "@/lib/api/webhooks/dispatch";
import { createTaskServerSide } from "@/lib/server/tasks-service";
import { recordUsage } from "@/lib/server/usage-meter";
import type { SubAccountDoc, VoiceCampaignOutcome } from "@/types";
import { runAfterResponse } from "@/lib/server/after-response";

/**
 * Vapi end-of-call handler, called from /api/webhooks/vapi/end-of-call/[subAccountId]
 * after Vapi's post-call analysis. Like the web chat capture: reconcile a
 * Contact (phone first; voice always has caller ID), create a Task, send the
 * escalation email. Also writes one summary doc per call at
 * subAccounts/{saId}/voiceCalls/{callId}, including the transcript.
 *
 * Failures are logged and the route still 200s, because Vapi retries 5xx and
 * we'd get duplicate Tasks and emails.
 */

export interface VapiEndOfCallPayload {
  /** Also the voiceCalls doc id, so retried deliveries dedupe. */
  callId: string;
  /** E.164. Always present for inbound PSTN calls. */
  callerPhone: string | null;
  /** Our Twilio number. */
  toPhone: string | null;
  durationSec: number;
  /** Used in the escalation email and the voiceCalls doc. */
  summary: string | null;
  /** e.g. "completed" | "no-answer" | "failed" | "busy" | "canceled". Stored as given. */
  endedReason: string | null;
  /** From Vapi's analysis plan. May be empty. */
  extracted: {
    name?: string | null;
    email?: string | null;
    phone?: string | null;
    callbackRequested?: boolean | null;
    /** Outbound only: interested in the offer? */
    interested?: boolean | null;
    /** Outbound only: one line on what interested them. */
    interestReason?: string | null;
    reason?: string | null;
  };
  /** Normalised by the route, which handles Vapi's payload variants. */
  transcript: Array<{
    role: "assistant" | "user" | "system";
    content: string;
    secondsFromStart: number | null;
  }>;
  /**
   * Set for calls placed by /api/comms/voice/call (from Vapi metadata).
   * Undefined means inbound. We never write a default, which could clobber the
   * outbound placeholder doc the trigger route wrote.
   */
  direction?: "outbound";
  /** From the outbound call's metadata; fallback when phone matching finds nobody. */
  metaContactId?: string | null;
  /** Bulk-campaign call: the outcome is written back to the recipient row. */
  metaCampaignId?: string | null;
}

/** Stamped on the voiceCalls doc during the call. */
type VoiceBookingStamp = {
  attemptedAt?: string | null;
  booked?: { eventId: string; startAtIso: string } | null;
};

export interface EndOfCallResult {
  contactId: string | null;
  contactCreated: boolean;
  taskId: string | null;
  emailSent: boolean;
  errors: string[];
}

export async function handleVapiEndOfCall(input: {
  subAccountId: string;
  payload: VapiEndOfCallPayload;
}): Promise<EndOfCallResult> {
  const { subAccountId, payload } = input;
  const errors: string[] = [];

  const saSnap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  if (!saSnap.exists) {
    errors.push("subAccount: not found");
    return {
      contactId: null,
      contactCreated: false,
      taskId: null,
      emailSent: false,
      errors,
    };
  }
  const subAccount = saSnap.data() as SubAccountDoc;

  // Booking correlation the LLM loop stamped mid-call. Read before the task
  // block so a booking outcome drives the follow-up.
  let voiceBooking: VoiceBookingStamp | null = null;
  try {
    const callSnap = await getAdminDb()
      .doc(`subAccounts/${subAccountId}/voiceCalls/${payload.callId}`)
      .get();
    voiceBooking =
      (callSnap.data()?.voiceBooking as VoiceBookingStamp | undefined) ?? null;
  } catch {
    voiceBooking = null;
  }

  // Caller ID wins unless an explicit callback number was extracted; the voice
  // rails only fill extracted.phone when the caller asks to be called on a
  // different number.
  const capturedName = sanitize(payload.extracted.name);
  const capturedEmail = sanitize(payload.extracted.email);
  const explicitCallbackPhone = sanitize(payload.extracted.phone);
  const callerPhone = sanitize(payload.callerPhone);
  const capturedPhone = explicitCallbackPhone ?? callerPhone;

  let contactId: string | null = null;
  let contactCreated = false;

  // No phone and no email: nothing to build a Contact from, so only write the summary doc.
  if (capturedPhone || capturedEmail) {
    try {
      const reconciled = await reconcileContactFromCapture({
        agencyId: subAccount.agencyId,
        subAccountId,
        existingContactId: null,
        pageUrl: null,
        source: "voice",
        matchStrategy: "phone-first",
        capture: {
          name: capturedName,
          email: capturedEmail,
          phone: capturedPhone,
        },
      });
      if (reconciled) {
        contactId = reconciled.contactId;
        contactCreated = reconciled.created;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error(
        `[voice/end-of-call] reconcile failed sa=${subAccountId}`,
        err,
      );
      errors.push(`contact: ${msg}`);
    }
  }

  // Outbound calls already know the contact. Use the metadata id if phone
  // matching missed (e.g. the number on file differs slightly from caller ID).
  if (!contactId && payload.metaContactId) {
    contactId = payload.metaContactId;
  }

  // Follow-up task, if any:
  //   booking completed: "Follow up with" (phone-only booking, so no
  //                      confirmation email went out)
  //   booking attempted but not finished: "Call back"
  //   caller asked for a callback: "Call back"
  // Booking is checked first because callers who book never trigger Vapi's
  // callbackRequested. Info-only calls create nothing so they don't clutter the
  // Today list. Needs a contactId either way.
  let taskId: string | null = null;
  let emailSent = false;
  const callbackRequested = payload.extracted.callbackRequested === true;

  let followUp:
    | { taskAction: "Follow up with" | "Call back"; note: string | null }
    | null = null;
  if (voiceBooking?.booked) {
    followUp = {
      taskAction: "Follow up with",
      note: `Booked an appointment by phone via the voice agent (it's on the calendar). NOTE: voice bookings are phone-only — NO confirmation email was sent to the customer, so confirm the appointment with them directly.${
        payload.summary ? `\n\nCall summary: ${payload.summary}` : ""
      }`,
    };
  } else if (voiceBooking?.attemptedAt) {
    followUp = {
      taskAction: "Call back",
      note: `Tried to book an appointment by phone but the call ended before one was confirmed. Follow up to lock in a time.${
        payload.summary ? `\n\nCall summary: ${payload.summary}` : ""
      }`,
    };
  } else if (callbackRequested) {
    followUp = { taskAction: "Call back", note: payload.summary };
  }

  if (contactId && followUp) {
    const created = await createCaptureFollowUp({
      agencyId: subAccount.agencyId,
      subAccountId,
      channelId: "voice",
      channelLabel: "Voice",
      taskAction: followUp.taskAction,
      sessionNoun: "call",
      sessionId: payload.callId,
      // No transcript page, so the email links to the contact.
      sessionDeepLinkPath: null,
      contactId,
      capturedName,
      capturedEmail,
      capturedPhone,
      lastInboundMessage: followUp.note ?? payload.summary,
      pageUrl: null,
    });
    taskId = created.taskId;
    emailSent = created.emailSent;
    errors.push(...created.errors);
  }

  // Campaign call: write the disposition to the recipient row. An interested
  // lead gets a follow-up Task only, no auto-email; a person works the queue.
  const interested = payload.extracted.interested === true;
  if (payload.metaCampaignId && contactId) {
    const campaignId = payload.metaCampaignId;
    const db = getAdminDb();
    const outcome = deriveCampaignOutcome({
      interested,
      callbackRequested,
      endedReason: payload.endedReason,
      durationSec: payload.durationSec,
      hadConversation: payload.transcript.some((t) => t.role === "user"),
    });

    let campaignTaskId: string | null = null;
    if (interested || callbackRequested) {
      try {
        const campaignSnap = await db.doc(`voiceCampaigns/${campaignId}`).get();
        const code =
          (campaignSnap.data()?.code as string | undefined) ?? "campaign";
        const cname = (campaignSnap.data()?.name as string | undefined) ?? "";
        const label = cname ? `${code} · ${cname}` : code;
        const identity =
          capturedName || capturedPhone || capturedEmail || "this contact";
        const now = new Date();
        const dueAt = new Date(
          now.getFullYear(),
          now.getMonth(),
          now.getDate(),
          23,
          59,
          59,
        );
        // Shared helper so task.created fires and `mode` is set (the public API's
        // mode filter needs it). Territory resolves inside.
        const created = await createTaskServerSide({
          subAccountId,
          agencyId: subAccount.agencyId,
          createdByUid: "voice-campaign-bot",
          mode: "live",
          title: `Follow up: ${interested ? "interested" : "callback"} — ${identity} (${label})`,
          notes: [
            `Outbound AI campaign call: ${label}`,
            payload.extracted.interestReason
              ? `Interest: ${payload.extracted.interestReason}`
              : null,
            payload.summary ? `\nCall summary:\n"${payload.summary}"` : null,
          ]
            .filter(Boolean)
            .join("\n"),
          dueAt,
          contactId,
          dealId: null,
          eventId: null,
        });
        campaignTaskId = created.id;
      } catch (err) {
        console.error(
          `[voice/end-of-call] campaign task failed sa=${subAccountId}`,
          err,
        );
        errors.push(
          `campaign-task: ${err instanceof Error ? err.message : "error"}`,
        );
      }
    }

    try {
      await db
        .doc(`voiceCampaigns/${campaignId}/recipients/${contactId}`)
        .update({
          outcome,
          callDurationSec: payload.durationSec,
          endedReason: payload.endedReason,
          callSummary: payload.summary,
          taskId: campaignTaskId,
        });
      if (interested) {
        await db
          .doc(`voiceCampaigns/${campaignId}`)
          .update({ "totals.interested": FieldValue.increment(1) })
          .catch(() => {});
      }
    } catch (err) {
      console.error(
        `[voice/end-of-call] campaign recipient update failed sa=${subAccountId}`,
        err,
      );
      errors.push(
        `campaign-recipient: ${err instanceof Error ? err.message : "error"}`,
      );
    }
  }

  // Always write the summary doc so every call is visible, even wrong numbers
  // and hang-ups. Doc id = callId, so retries dedupe.
  try {
    await getAdminDb()
      .doc(`subAccounts/${subAccountId}/voiceCalls/${payload.callId}`)
      .set(
        {
          agencyId: subAccount.agencyId,
          subAccountId,
          callId: payload.callId,
          // Only stamp direction when metadata says outbound. Inbound omits it, and the
          // merge keeps the outbound placeholder either way.
          ...(payload.direction === "outbound"
            ? { direction: "outbound" as const }
            : {}),
          callerPhone: callerPhone,
          toPhone: sanitize(payload.toPhone),
          durationSec: payload.durationSec,
          summary: payload.summary,
          endedReason: payload.endedReason,
          contactId,
          contactCreated,
          callbackRequested,
          capturedName,
          capturedEmail,
          capturedPhone,
          taskId,
          escalationEmailSent: emailSent,
          transcript: payload.transcript,
          errors,
          createdAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(
      `[voice/end-of-call] summary doc write failed sa=${subAccountId}`,
      err,
    );
    errors.push(`summary: ${msg}`);
  }

  // Every call lands here once (callId dedupes retries upstream).
  runAfterResponse(() => recordUsage({
    subAccountId,
    unit: "voiceSeconds",
    qty: payload.durationSec,
    subAccount,
  }));

  // Put the call on the contact's timeline, which is where operators look first.
  if (contactId) {
    try {
      const mins = Math.floor(payload.durationSec / 60);
      const secs = payload.durationSec % 60;
      const dur = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
      await getAdminDb()
        .collection("contacts")
        .doc(contactId)
        .collection("activities")
        .add({
          type: "voice_call_completed",
          content: `${payload.direction === "outbound" ? "Outbound" : "Inbound"} AI call (${dur})${
            payload.summary ? ` — ${payload.summary.slice(0, 200)}` : ""
          }`,
          createdBy: "voice-agent",
          meta: { callId: payload.callId, endedReason: payload.endedReason ?? null },
          createdAt: FieldValue.serverTimestamp(),
        });
    } catch (err) {
      console.warn(
        `[voice/end-of-call] activity write failed sa=${subAccountId}`,
        err,
      );
      errors.push("activity: write failed");
    }
  }

  // Public-API webhooks: always voice.call.completed, plus voice.call.captured
  // when the call produced contact identity. Fire-and-forget; dispatch failures
  // mustn't affect the Vapi response.
  void emitWebhookEvent({
    subAccountId,
    agencyId: subAccount.agencyId,
    mode: "live",
    type: "voice.call.completed",
    payload: {
      call: {
        id: payload.callId,
        object: "voice_call",
        caller_phone: callerPhone,
        to_phone: sanitize(payload.toPhone),
        duration_seconds: payload.durationSec,
        summary: payload.summary,
        ended_reason: payload.endedReason,
        contact_id: contactId,
        callback_requested: callbackRequested,
        ended_at: new Date().toISOString(),
      },
    },
  });
  if (contactId && (capturedEmail || capturedName || capturedPhone)) {
    void emitWebhookEvent({
      subAccountId,
      agencyId: subAccount.agencyId,
      mode: "live",
      type: "voice.call.captured",
      payload: {
        call: {
          id: payload.callId,
          object: "voice_call",
          caller_phone: callerPhone,
          summary: payload.summary,
          contact_id: contactId,
        },
        captured: {
          name: capturedName,
          email: capturedEmail,
          phone: capturedPhone,
          callback_requested: callbackRequested,
        },
      },
    });
  }

  return { contactId, contactCreated, taskId, emailSent, errors };
}

function sanitize(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 500) : null;
}

/** Collapse the call's signals into one campaign outcome. */
function deriveCampaignOutcome(input: {
  interested: boolean;
  callbackRequested: boolean;
  endedReason: string | null;
  durationSec: number;
  hadConversation: boolean;
}): VoiceCampaignOutcome {
  if (input.interested) return "interested";
  if (input.callbackRequested) return "callback";
  const reason = (input.endedReason ?? "").toLowerCase();
  if (reason.includes("voicemail")) return "voicemail";
  if (
    reason.includes("no-answer") ||
    reason.includes("noanswer") ||
    reason.includes("did-not-answer") ||
    reason.includes("not-answer")
  ) {
    return "no_answer";
  }
  if (
    reason.includes("busy") ||
    reason.includes("failed") ||
    reason.includes("error")
  ) {
    return "failed";
  }
  // Connected with no real exchange counts as no-answer, not a declined lead.
  if (!input.hadConversation || input.durationSec < 5) return "no_answer";
  return "not_interested";
}
