import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import type { AiChatMessage } from "@/lib/comms/ai/openrouter";
import {
  incrementChannelTokens,
  resolveAgent,
} from "@/lib/comms/ai/agent";
import { buildContactContextBlock } from "@/lib/comms/ai/context";
import { buildSystemPrompt } from "@/lib/comms/ai/prompt";
import { isWithinBusinessHours } from "@/lib/comms/business-hours";
import { checkQuotas } from "@/lib/server/usage-meter";
import {
  matchEscalationKeyword,
  sendEscalationNotification,
} from "@/lib/comms/ai/escalation";
import {
  appendMessage,
  getOrCreateSession,
  loadRecentHistory,
  markCapturePromptShown,
} from "@/lib/comms/web-chat/session";
import {
  parseCaptureMarker,
  parseFormMarker,
  reconcileContactFromCapture,
  type CaptureFieldId,
} from "@/lib/comms/web-chat/capture";
import {
  getConversationControls,
  setConversationDraft,
  upsertConversationForMessage,
} from "@/lib/server/conversations-service";
import {
  callAiWithWebChatBooking,
  prepareWebChatBooking,
} from "@/lib/comms/web-chat/booking";
import { webChatConversationId } from "@/types/conversations";
import type { SubAccountDoc } from "@/types";
import type { Contact } from "@/types/contacts";
import type { WebChatOfferedSlot, WebChatSession } from "@/types/web-chat";
import { runAfterResponse } from "@/lib/server/after-response";

/**
 * Web-chat reply orchestrator, the web counterpart of `maybeRespondWithAi`.
 * Returns the reply text (the widget gets it as the response body) instead of
 * sending, persists to `webChatSessions/{id}/messages/*`, skips contact
 * context until the session is linked via [[capture ...]], and strips that
 * marker before storing or returning.
 *
 * Guards return a structured outcome so the widget can show a neutral
 * fallback; the outcome is also logged on the message.
 */

export type WebChatSkipReason =
  | "agent_not_configured"
  | "channel_disabled"
  | "no_prompt"
  | "outside_hours"
  | "escalation_keyword"
  | "llm_failed"
  // A human is handling this thread from the unified inbox. Either the
  // per-conversation AI mode is "off", or a human reply paused the bot.
  | "human_takeover"
  // AI mode is "suggest": the bot drafted a reply for operator approval
  // instead of sending it to the visitor.
  | "suggest_draft"
  // Monthly AI usage quota reached: no LLM call.
  | "quota";

export type WebChatOutcome =
  | {
      kind: "replied";
      replyText: string;
      tokens: number;
      contactId: string | null;
      /** Fields for the inline form the widget renders under this reply. Null on most replies. */
      formFields: CaptureFieldId[] | null;
      /** Bookable times the widget shows as buttons under this reply. Typed chat only; null on most replies. */
      slotButtons: WebChatOfferedSlot[] | null;
    }
  | { kind: "escalated"; keyword: string; fallbackReply: string }
  | { kind: "skipped"; reason: WebChatSkipReason; fallbackReply: string };

export interface RespondToWebChatInput {
  subAccountId: string;
  agencyId: string;
  /** Client-generated UUID kept in the visitor's localStorage. */
  sessionId: string;
  incomingMessage: string;
  /** Seeds the session; null fields are fine. */
  pageUrl: string | null;
  referrer: string | null;
  origin: string | null;
  visitorIp: string | null;
  visitorUserAgent: string | null;
  /**
   * "voice" when the visitor is talking through Web Voice (ElevenLabs speaks
   * the reply). Same guards/persona/KB/capture, plus a spoken-reply prompt
   * addendum, shorter completions, no inline [[form]] (nothing can be shown
   * mid-call), and turns stamped `via: "voice"`. Default "text".
   */
  mode?: "text" | "voice";
  /**
   * Start value of a time button the visitor tapped. Only honoured when it
   * matches a time stored on the session's booking offer.
   */
  pickedSlotIso?: string | null;
}

/** Appended in voice mode; overrides the typed-panel formatting rules above it. */
const VOICE_MODE_BLOCK = `--- VOICE MODE ---
The visitor is now TALKING to you through their microphone on the website, and your reply is read aloud by a text-to-speech voice. This overrides the formatting rules above:
- Keep every reply short and natural: 1-2 sentences, never more than 3.
- No markdown, bullet points, emoji, links or URLs — every symbol you write is spoken. Never read out a web address.
- NEVER emit a [[form]] marker — no form can be shown during a voice conversation.
- To capture contact details, ask for them one at a time: first their name, then the best phone number or email. Read an email address back in spoken form ("jane at example dot com") so they can confirm it. Once they confirm, add ONE [[capture name="…" email="…" phone="…"]] marker at the very end of your reply (only the fields you actually have, written normally, e.g. jane@example.com). The marker is removed before your reply is spoken.
- If the visitor would rather type, tell them they can use the chat box at any time.
--- END VOICE MODE ---`;

/** Shown to the visitor when the bot can't or won't answer, so keep it neutral. */
const FALLBACK_REPLY =
  "Thanks for reaching out! I'll have someone from the team get back to you shortly.";

/**
 * Outside-hours reply. Not the generic fallback: the LLM never runs here, so
 * no form can fire and no contact exists, and "someone will get back to you"
 * would be a promise nothing keeps. The transcript is saved to the operator's
 * Sessions console, so "your message has been saved" is true.
 */
const OUT_OF_HOURS_REPLY =
  "Thanks for your message! We're currently closed, but your message has been saved — check back during business hours and we'll pick things up from here.";

/**
 * Held states: a human has the thread (AI off, paused, or suggest mode). The
 * bot stays silent and nothing is appended to the transcript, so repeat
 * messages don't produce repeat holding lines. `offline` (held message outside
 * hours) tells the widget to show "we're offline" at once; within hours it
 * arms its own timer for a softer note and polls for the operator's reply.
 */
function heldResult(
  session: WebChatSession,
  reason: WebChatSkipReason,
  offline: boolean,
): {
  session: WebChatSession;
  outcome: WebChatOutcome;
  outboundMessageId: string;
  offline: boolean;
} {
  return {
    session,
    outcome: { kind: "skipped", reason, fallbackReply: "" },
    outboundMessageId: "",
    offline,
  };
}

/** Anonymous visitor label from the page they're on. The capture route uses it for the inbox row too. */
export function webChatVisitorLabel(
  pageUrl: string | null,
  referrer: string | null = null,
): string {
  const raw = pageUrl ?? referrer ?? null;
  if (!raw) return "Web visitor";
  try {
    const u = new URL(raw);
    const path = u.pathname && u.pathname !== "/" ? u.pathname : u.hostname;
    return `Web visitor · ${path}`.slice(0, 80);
  } catch {
    return "Web visitor";
  }
}

function buildVisitorLabel(session: WebChatSession): string {
  return webChatVisitorLabel(session.pageUrl ?? null, session.referrer ?? null);
}

/** Inbox name: captured name, then "Web lead" once a contact exists, else the visitor label. */
function displayNameFor(
  session: WebChatSession,
  contactId: string | null,
  label: string,
): string {
  if (session.capturedName?.trim()) return session.capturedName.trim();
  return contactId ? "Web lead" : label;
}

const isWithinHours = isWithinBusinessHours;

export async function respondToWebChat(
  input: RespondToWebChatInput,
): Promise<{
  session: WebChatSession;
  outcome: WebChatOutcome;
  /** Id of the outbound message just written; the widget adds it to its seen-set so polling won't render it twice. */
  outboundMessageId: string;
  /** Held outcomes only: outside hours, so the widget says "we're offline" instead of waiting. */
  offline?: boolean;
}> {
  const db = getAdminDb();
  const isVoice = input.mode === "voice";

  // Get-or-create first so rejected messages still have a thread to log against.
  const session = await getOrCreateSession({
    subAccountId: input.subAccountId,
    agencyId: input.agencyId,
    sessionId: input.sessionId,
    pageUrl: input.pageUrl,
    referrer: input.referrer,
    origin: input.origin,
    visitorIp: input.visitorIp,
    visitorUserAgent: input.visitorUserAgent,
  });

  // Inbound is persisted regardless of outcome.
  await appendMessage({
    subAccountId: input.subAccountId,
    agencyId: input.agencyId,
    sessionId: input.sessionId,
    direction: "inbound",
    body: input.incomingMessage,
    tokens: null,
    aiGenerated: false,
    ...(isVoice ? { via: "voice" as const } : {}),
  });

  // Session-keyed inbox row so anonymous visitors show up live. Upsert swallows its own errors.
  const visitorLabel = buildVisitorLabel(session);
  await upsertConversationForMessage({
    contactId: session.contactId,
    conversationKey: webChatConversationId(input.sessionId),
    sessionId: input.sessionId,
    visitorLabel,
    subAccountId: input.subAccountId,
    agencyId: input.agencyId,
    contactName: displayNameFor(session, session.contactId, visitorLabel),
    contactPhone: session.capturedPhone ?? null,
    channel: "web-chat",
    direction: "inbound",
    body: input.incomingMessage,
  });

  // auto / suggest / off plus human-takeover pause. Missing doc = auto, not paused.
  const controls = await getConversationControls(
    webChatConversationId(input.sessionId),
  );
  const botPaused =
    controls.botPausedUntilMs !== null &&
    controls.botPausedUntilMs > Date.now();

  const agent = await resolveAgent(input.subAccountId, "web-chat");
  if (!agent) {
    return finalize(input, session, {
      kind: "skipped",
      reason: "agent_not_configured",
      fallbackReply: FALLBACK_REPLY,
    });
  }
  const eff = agent.effective;

  if (!eff.enabled) {
    return finalize(input, session, {
      kind: "skipped",
      reason: "channel_disabled",
      fallbackReply: FALLBACK_REPLY,
    });
  }
  if (!eff.systemPrompt.trim()) {
    return finalize(input, session, {
      kind: "skipped",
      reason: "no_prompt",
      fallbackReply: FALLBACK_REPLY,
    });
  }

  // Mode "off" or paused by a human reply: no LLM spend, no escalation and no
  // reply written. The widget shows a one-time note and polls for the human.
  if (controls.botMode === "off" || botPaused) {
    const offline = !isWithinHours(eff.hoursStart, eff.hoursEnd, eff.timezone);
    return heldResult(session, "human_takeover", offline);
  }

  if (!isWithinHours(eff.hoursStart, eff.hoursEnd, eff.timezone)) {
    return finalize(input, session, {
      kind: "skipped",
      reason: "outside_hours",
      fallbackReply: OUT_OF_HOURS_REPLY,
    });
  }

  // Monthly AI-token quota, checked before the LLM call so an over-cap workspace
  // spends nothing. Fails open. The generic fallback is honest here since the
  // transcript reaches the Sessions console.
  const tokenQuota = await checkQuotas({
    subAccountId: input.subAccountId,
    // A voice call is limited when it starts, never cut off mid-call.
    units: isVoice ? ["aiTokens"] : ["aiTokens", "aiReplies"],
  });
  if (!tokenQuota.allowed) {
    return finalize(input, session, {
      kind: "skipped",
      reason: "quota",
      fallbackReply: FALLBACK_REPLY,
    });
  }

  const triggered = matchEscalationKeyword(
    input.incomingMessage,
    eff.escalationKeywords,
  );
  if (triggered) {
    // Best-effort; email errors never fail the visitor's response.
    const notifyEmail = eff.escalationNotifyEmail;
    if (notifyEmail) {
      const saSnap = await db.doc(`subAccounts/${input.subAccountId}`).get();
      const subAccount = saSnap.data() as SubAccountDoc | undefined;
      const appUrl =
        process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://leadstack.dev";
      runAfterResponse(() => sendEscalationNotification({
        to: notifyEmail,
        businessName:
          eff.businessName.trim() || subAccount?.name || "your business",
        contactName: session.capturedName ?? "(anonymous web visitor)",
        contactPhone: session.capturedPhone ?? "—",
        contactId: session.contactId ?? input.sessionId,
        subAccountId: input.subAccountId,
        triggeredKeyword: triggered,
        incomingMessage: input.incomingMessage,
        appUrl,
      }).catch((err) => {
        console.warn(
          `[web-chat/respond] escalation email failed sa=${input.subAccountId}`,
          err,
        );
      }));
    }
    return finalize(input, session, {
      kind: "escalated",
      keyword: triggered,
      fallbackReply: FALLBACK_REPLY,
    });
  }

  let contextBlock: string | null = null;
  if (session.contactId) {
    try {
      const contactSnap = await db
        .collection("contacts")
        .doc(session.contactId)
        .get();
      if (contactSnap.exists) {
        const contact = {
          id: contactSnap.id,
          ...(contactSnap.data() as Omit<Contact, "id">),
        };
        contextBlock = await buildContactContextBlock(contact);
      }
    } catch (err) {
      console.warn(
        `[web-chat/respond] contact context build failed for ${session.contactId}`,
        err,
      );
    }
  }

  // History is read after appending the inbound, so excludeBody avoids feeding that turn twice.
  const history = await loadRecentHistory(
    input.subAccountId,
    input.sessionId,
    eff.contextMessageCount,
    input.incomingMessage,
  );

  const saSnap = await db.doc(`subAccounts/${input.subAccountId}`).get();
  const subAccount = saSnap.data() as SubAccountDoc | undefined;

  let systemPrompt = buildSystemPrompt({
    agent,
    channelId: "web-chat",
    fallbackBusinessName: subAccount?.name ?? "the business",
    contactContextBlock: contextBlock,
    bookingLink: subAccount?.bookingLink ?? null,
  });

  // Session-state hint once capture is done or skipped, in case the bot forgets
  // the "AT MOST ONCE" rule and keeps asking.
  if (session.contactId) {
    systemPrompt += `\n\n--- SESSION STATE ---\nContact details for this visitor have already been captured. Do NOT emit a [[form]] or [[capture]] marker. Continue the conversation normally; the team will follow up.`;
  } else if (session.capturePromptShownAt) {
    systemPrompt += `\n\n--- SESSION STATE ---\nA capture form has already been shown to this visitor${session.captureSkipped ? " and they skipped it" : ""}. Do NOT emit another [[form]] or [[capture]] marker on this session.`;
  }
  if (isVoice) systemPrompt += `\n\n${VOICE_MODE_BLOCK}`;

  // Live booking only when the bot replies directly. A suggest-mode draft must
  // never book: "you're booked" with no event behind it is worse than a link.
  const booking =
    controls.botMode === "auto"
      ? await prepareWebChatBooking({
          subAccountId: input.subAccountId,
          bookingPageSlug: agent.channel.webChat?.bookingPageSlug,
          session,
          isVoice,
          pickedSlotIso: isVoice ? null : (input.pickedSlotIso ?? null),
          askIntake: agent.profile.bookingAskIntake === true,
        })
      : null;
  if (booking) systemPrompt += `\n\n${booking.promptBlock}`;

  const messages: AiChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: input.incomingMessage },
  ];

  let completion;
  try {
    completion = await callAiWithWebChatBooking({
      messages,
      ai: {
        model: eff.modelOverride ?? undefined,
        // Spoken replies stay short (same caps as the Vapi voice route).
        ...(isVoice ? { maxTokens: 220, temperature: 0.5 } : {}),
      },
      booking,
      subAccountId: input.subAccountId,
      isVoice,
      agencyId: input.agencyId,
      sessionId: input.sessionId,
      session,
      pageUrl: input.pageUrl,
      visitorIp: input.visitorIp,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(
      `[web-chat/respond] LLM call failed sa=${input.subAccountId}: ${msg}`,
    );
    return finalize(input, session, {
      kind: "skipped",
      reason: "llm_failed",
      fallbackReply: FALLBACK_REPLY,
    });
  }

  // The bot is told to emit form OR capture; run both parsers in case it does both.
  const afterForm = parseFormMarker(completion.text);
  const afterCapture = parseCaptureMarker(afterForm.cleanText);
  const cleanText = afterCapture.cleanText;
  const capture = afterCapture.capture;

  // Drop the form if it was already shown or the visitor is linked; the prompt
  // says the same but bots drift. Voice can't render one either, and doesn't
  // stamp "form shown" so typed chat can still offer it later.
  // A booking this turn links the contact, so it counts as handled too.
  let contactId = completion.contactId;
  const formAlreadyHandled =
    !!contactId || !!session.capturePromptShownAt || completion.booked;
  const formFields = formAlreadyHandled || isVoice ? null : afterForm.fields;

  // Bot extracted details the visitor volunteered.
  if (capture) {
    try {
      const reconciled = await reconcileContactFromCapture({
        agencyId: input.agencyId,
        subAccountId: input.subAccountId,
        sessionId: input.sessionId,
        existingContactId: contactId,
        pageUrl: input.pageUrl,
        capture,
      });
      if (reconciled) contactId = reconciled.contactId;
    } catch (err) {
      console.warn(
        `[web-chat/respond] capture reconcile failed sa=${input.subAccountId}`,
        err,
      );
    }
  }

  // Stamp now so the next turn won't ask again.
  if (formFields) {
    runAfterResponse(() => markCapturePromptShown({
      subAccountId: input.subAccountId,
      sessionId: input.sessionId,
    }).catch(() => {}));
  }

  runAfterResponse(() => incrementChannelTokens(
    input.subAccountId,
    "web-chat",
    completion.totalTokens,
    // A suggest-mode draft is billed when an operator sends it, not now.
    { reply: !isVoice && controls.botMode !== "suggest" },
  ));

  // Suggest mode: park the draft on the conversation for an operator to
  // approve/edit and send from the inbox.
  if (controls.botMode === "suggest") {
    runAfterResponse(() => setConversationDraft({
      contactId: contactId ?? null,
      conversationKey: webChatConversationId(input.sessionId),
      sessionId: input.sessionId,
      visitorLabel,
      subAccountId: input.subAccountId,
      agencyId: input.agencyId,
      contactName: displayNameFor(session, contactId, visitorLabel),
      contactPhone: session.capturedPhone ?? null,
      channel: "web-chat",
      body: cleanText,
      model: completion.model,
      tokens: completion.totalTokens,
    }));
    // Silent to the visitor; the approved send arrives via the poll. Suggest mode
    // only runs after the hours gate, so never offline.
    return heldResult(session, "suggest_draft", false);
  }

  return finalize(input, session, {
    kind: "replied",
    replyText: cleanText,
    tokens: completion.totalTokens,
    contactId: contactId ?? null,
    formFields,
    // A form and time buttons under the same reply would compete.
    slotButtons: formFields ? null : completion.slotButtons,
  });
}

/** Writes the outbound reply/fallback and returns the outcome; every path goes through here. */
async function finalize(
  input: RespondToWebChatInput,
  session: WebChatSession,
  outcome: WebChatOutcome,
): Promise<{
  session: WebChatSession;
  outcome: WebChatOutcome;
  outboundMessageId: string;
}> {
  const body =
    outcome.kind === "replied" ? outcome.replyText : outcome.kind === "escalated"
      ? outcome.fallbackReply
      : outcome.fallbackReply;
  const tokens = outcome.kind === "replied" ? outcome.tokens : null;
  const aiGenerated = outcome.kind === "replied";

  const outboundMessageId = await appendMessage({
    subAccountId: input.subAccountId,
    agencyId: input.agencyId,
    sessionId: input.sessionId,
    direction: "outbound",
    body,
    tokens,
    aiGenerated,
    ...(input.mode === "voice" ? { via: "voice" as const } : {}),
  });

  // pauseBot stays false: this is the bot speaking, so it must not pause the AI
  // or clear unread. Human replies go through /api/comms/web-chat/send.
  const finalContactId =
    outcome.kind === "replied" ? outcome.contactId : session.contactId;
  const label = buildVisitorLabel(session);
  await upsertConversationForMessage({
    contactId: finalContactId,
    conversationKey: webChatConversationId(input.sessionId),
    sessionId: input.sessionId,
    visitorLabel: label,
    subAccountId: input.subAccountId,
    agencyId: input.agencyId,
    contactName: displayNameFor(session, finalContactId, label),
    contactPhone: session.capturedPhone ?? null,
    channel: "web-chat",
    direction: "outbound",
    body,
  });

  if (outcome.kind === "escalated") {
    await getAdminDb()
      .doc(
        `subAccounts/${input.subAccountId}/webChatSessions/${input.sessionId}`,
      )
      .update({
        status: "escalated",
        updatedAt: FieldValue.serverTimestamp(),
      });
  }

  return { session, outcome, outboundMessageId };
}
