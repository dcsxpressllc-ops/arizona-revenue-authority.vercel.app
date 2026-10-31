import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getChannelConfig } from "@/lib/comms/ai/agent";
import { checkAndCount } from "@/lib/comms/web-chat/rate-limit";
import {
  appendMessage,
  isValidSessionId,
  markCaptureSkipped,
} from "@/lib/comms/web-chat/session";
import { reconcileContactFromCapture } from "@/lib/comms/web-chat/capture";
import { createFollowUpActions } from "@/lib/comms/web-chat/follow-up";
import { webChatVisitorLabel } from "@/lib/comms/web-chat/respond";
import { upsertConversationForMessage } from "@/lib/server/conversations-service";
import { webChatConversationId } from "@/types/conversations";
import { emitWebhookEvent } from "@/lib/api/webhooks/dispatch";
import { ipFromRequest } from "@/lib/contacts/location";
import type { SubAccountDoc } from "@/types";

export const dynamic = "force-dynamic";

/**
 * Widget inline-form endpoint, for forms shown in response to a
 * [[form fields="..."]] marker.
 * Submit: validate, create or reconcile the contact, link the session, and
 * write a visitor + bot turn so the thread shows what happened.
 * Skip: set captureSkipped so the bot stops asking.
 *
 * No origin check, same as /message (the iframe is on our domain); gated by
 * channel enabled, rate limits and a valid sessionId.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9][\d\s\-().]{5,}$/;

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export async function OPTIONS(request: Request) {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(request.headers.get("origin")),
  });
}

export async function POST(request: Request) {
  const headers = corsHeaders(request.headers.get("origin"));

  let body: {
    sa?: string;
    sessionId?: string;
    skip?: boolean;
    name?: string;
    email?: string;
    phone?: string;
    pageUrl?: string;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON" },
      { status: 400, headers },
    );
  }

  const subAccountId = body.sa?.trim();
  const sessionId = body.sessionId?.trim();
  if (!subAccountId) {
    return NextResponse.json({ error: "Missing sa" }, { status: 400, headers });
  }
  if (!isValidSessionId(sessionId)) {
    return NextResponse.json(
      { error: "Invalid sessionId" },
      { status: 400, headers },
    );
  }

  const config = await getChannelConfig(subAccountId, "web-chat");
  if (!config || !config.enabled) {
    return NextResponse.json(
      { error: "Web Chat is not enabled for this sub-account" },
      { status: 403, headers },
    );
  }

  // Same buckets as /message so callers can't hop endpoints to dodge caps.
  const ip = ipFromRequest(request) ?? "unknown";
  const rl = checkAndCount(ip, sessionId);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many requests" },
      {
        status: 429,
        headers: { ...headers, "Retry-After": String(rl.retryAfterSec) },
      },
    );
  }

  const db = getAdminDb();
  const sessionRef = db.doc(
    `subAccounts/${subAccountId}/webChatSessions/${sessionId}`,
  );
  const sessionSnap = await sessionRef.get();
  if (!sessionSnap.exists) {
    return NextResponse.json(
      { error: "Session not found" },
      { status: 404, headers },
    );
  }
  const session = sessionSnap.data() as {
    contactId: string | null;
    agencyId: string;
  };

  // Skip
  if (body.skip) {
    await markCaptureSkipped({ subAccountId, sessionId });
    const skipReply =
      "No problem — let me know if there's anything else you'd like to ask.";
    const skipMsgId = await appendMessage({
      subAccountId,
      agencyId: session.agencyId,
      sessionId,
      direction: "outbound",
      body: skipReply,
      tokens: 0,
      aiGenerated: false,
    });
    await upsertConversationForMessage({
      contactId: session.contactId,
      conversationKey: webChatConversationId(sessionId),
      sessionId,
      visitorLabel: webChatVisitorLabel(body.pageUrl ?? null),
      subAccountId,
      agencyId: session.agencyId,
      contactName: session.contactId ? "Web lead" : webChatVisitorLabel(body.pageUrl ?? null),
      contactPhone: null,
      channel: "web-chat",
      direction: "outbound",
      body: skipReply,
    });
    return NextResponse.json(
      { ok: true, reply: skipReply, messageId: skipMsgId },
      { status: 200, headers },
    );
  }

  // Submit
  const name = (body.name ?? "").trim().slice(0, 200) || null;
  const emailRaw = (body.email ?? "").trim();
  const phoneRaw = (body.phone ?? "").trim();
  const email = emailRaw && EMAIL_RE.test(emailRaw) ? emailRaw : null;
  const phone = phoneRaw && PHONE_RE.test(phoneRaw) ? phoneRaw : null;

  if (emailRaw && !email) {
    return NextResponse.json(
      { error: "That email doesn't look right — please check and try again." },
      { status: 400, headers },
    );
  }
  if (phoneRaw && !phone) {
    return NextResponse.json(
      { error: "That phone number doesn't look right — please check and try again." },
      { status: 400, headers },
    );
  }
  if (!email && !phone) {
    return NextResponse.json(
      { error: "Please enter at least an email or a phone number." },
      { status: 400, headers },
    );
  }

  // agencyId for the contact's tenancy stamp.
  const saSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  if (!saSnap.exists) {
    return NextResponse.json(
      { error: "Sub-account not found" },
      { status: 404, headers },
    );
  }
  const sa = saSnap.data() as SubAccountDoc;

  // Echo the submission into the thread as an inbound row so the history
  // reads naturally in the operator console.
  const submittedSummary = [
    name ? `name: ${name}` : null,
    email ? `email: ${email}` : null,
    phone ? `phone: ${phone}` : null,
  ]
    .filter(Boolean)
    .join(", ");
  await appendMessage({
    subAccountId,
    agencyId: session.agencyId,
    sessionId,
    direction: "inbound",
    body: `(submitted via form) ${submittedSummary}`,
    tokens: null,
    aiGenerated: false,
  });

  // Email match wins, otherwise create.
  let contactId: string | null = null;
  try {
    const reconciled = await reconcileContactFromCapture({
      agencyId: sa.agencyId,
      subAccountId,
      sessionId,
      existingContactId: session.contactId,
      pageUrl: body.pageUrl?.slice(0, 500) ?? null,
      capture: { name, email, phone },
    });
    contactId = reconciled?.contactId ?? null;
  } catch (err) {
    console.error(
      `[web-chat/capture] reconcile failed sa=${subAccountId}`,
      err,
    );
    return NextResponse.json(
      { error: "Couldn't save your details — please try again." },
      { status: 500, headers },
    );
  }

  // Follow-up: task for the operator + escalation email. Best-effort; errors
  // go in the response but don't block the visitor's thanks. The email wants
  // the visitor's last real message for context.
  let lastInboundMessage: string | null = null;
  try {
    const recentInbound = await sessionRef
      .collection("messages")
      .where("direction", "==", "inbound")
      .orderBy("createdAt", "desc")
      .limit(1)
      .get();
    if (!recentInbound.empty) {
      const data = recentInbound.docs[0].data() as { body?: string };
      // Skip the "(submitted via form)" row written above.
      if (data.body && !data.body.startsWith("(submitted via form)")) {
        lastInboundMessage = data.body;
      } else {
        const beforeForm = await sessionRef
          .collection("messages")
          .where("direction", "==", "inbound")
          .orderBy("createdAt", "desc")
          .limit(5)
          .get();
        for (const d of beforeForm.docs) {
          const b = (d.data() as { body?: string }).body;
          if (b && !b.startsWith("(submitted via form)")) {
            lastInboundMessage = b;
            break;
          }
        }
      }
    }
  } catch {
    // Logged only; the follow-up still runs without context.
  }

  const followUp = contactId
    ? await createFollowUpActions({
        agencyId: sa.agencyId,
        subAccountId,
        sessionId,
        contactId,
        capturedName: name,
        capturedEmail: email,
        capturedPhone: phone,
        lastInboundMessage,
        pageUrl: body.pageUrl?.slice(0, 500) ?? null,
      })
    : { taskId: null, emailSent: false, errors: ["no contact id"] };

  if (followUp.errors.length > 0) {
    console.warn(
      `[web-chat/capture] follow-up partial failure sa=${subAccountId}:`,
      followUp.errors.join("; "),
    );
  }

  await sessionRef.set(
    {
      capturePromptShownAt: FieldValue.serverTimestamp(),
      captureSkipped: false,
      pendingFollowUpTaskId: followUp.taskId,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  // Public-API webhook for captured chat leads. Fire-and-forget.
  if (contactId) {
    void emitWebhookEvent({
      subAccountId,
      agencyId: sa.agencyId,
      mode: "live",
      type: "webchat.lead.captured",
      payload: {
        session: {
          id: sessionId,
          object: "webchat_session",
          page_url: body.pageUrl?.slice(0, 500) ?? null,
        },
        captured: { name, email, phone },
        contact_id: contactId,
        task_id: followUp.taskId,
      },
    });
  }

  // Templated so the reply needs no LLM round-trip.
  const who = name ? name : "you";
  const reach = email ?? phone ?? "the details you provided";
  const reply = `Thanks ${who}! Someone from the team will reach out via ${reach} shortly.`;
  const replyMsgId = await appendMessage({
    subAccountId,
    agencyId: session.agencyId,
    sessionId,
    direction: "outbound",
    body: reply,
    tokens: 0,
    aiGenerated: false,
  });

  // Flips the inbox row from anonymous "Web visitor ..." to the real contact.
  await upsertConversationForMessage({
    contactId,
    conversationKey: webChatConversationId(sessionId),
    sessionId,
    visitorLabel: webChatVisitorLabel(body.pageUrl ?? null),
    subAccountId,
    agencyId: sa.agencyId,
    contactName: name || "Web lead",
    contactPhone: phone,
    channel: "web-chat",
    direction: "outbound",
    body: reply,
  });

  return NextResponse.json(
    {
      ok: true,
      reply,
      messageId: replyMsgId,
      contactId,
      taskId: followUp.taskId,
      emailSent: followUp.emailSent,
    },
    { status: 200, headers },
  );
}
