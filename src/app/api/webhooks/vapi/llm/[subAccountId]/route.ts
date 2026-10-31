import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import type { AiChatMessage } from "@/lib/comms/ai/openrouter";
import { incrementChannelTokens, resolveAgent } from "@/lib/comms/ai/agent";
import { checkQuota, getEffectiveBilling } from "@/lib/server/usage-meter";
import { endCallViaControl } from "@/lib/comms/voice/vapi";
import { buildContactContextBlock } from "@/lib/comms/ai/context";
import { buildSystemPrompt } from "@/lib/comms/ai/prompt";
import {
  bookAgentSlot,
  getAgentBookingContext,
  loadChangeableBookings,
} from "@/lib/server/agent-booking-service";
import {
  cancelBooking,
  rescheduleBooking,
} from "@/lib/server/booking-changes-service";
import {
  buildBookingToolsBlock,
  toChangeTargets,
  type ChangeTarget,
} from "@/lib/comms/ai/booking-tools";
import { callAiWithBookingTools } from "@/lib/comms/ai/booking-turn";
import {
  canChangeBooking,
  countBookingChange,
} from "@/lib/comms/ai/booking-caps";
import type { BookingPage } from "@/types/booking";
import type { SubAccountDoc } from "@/types";
import type { Contact } from "@/types/contacts";
import { runAfterResponse } from "@/lib/server/after-response";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Vapi custom-LLM webhook. Vapi POSTs an OpenAI-style chat completion on
 * every voice turn and reads our reply aloud.
 *
 * Vapi quirk: it string-concatenates `/chat/completions` onto the registered
 * model.url, which lands in the query string, not the path. We register the
 * URL with a trailing `&_=` so the suffix goes into `_` instead of
 * corrupting `s` (see buildAssistantBody() in vapi.ts).
 *
 * All voice replies come through here and must use the same resolveAgent()
 * + buildSystemPrompt() + callAi() pipeline as SMS and Web Chat so persona,
 * KB, hours and escalation stay consistent. Vapi's own system prompt is
 * ignored.
 *
 * Auth: custom-LLM has no native auth, so the secret is a `?s=` param baked
 * into the URL at provisioning.
 */

interface VapiLlmBody {
  model?: string;
  messages?: Array<{ role: string; content: string }>;
  /** Vapi defaults to true for voice: SSE when true, plain JSON when false. */
  stream?: boolean;
  /** Customer phone is used to find an existing contact for context. */
  call?: {
    id?: string;
    customer?: { number?: string };
    phoneNumber?: { number?: string };
    /** Stamped via assistantOverrides on outbound calls (createOutboundCall);
     *  echoed every turn so we can pick the outbound persona. */
    metadata?: { direction?: string; contactId?: string };
    /** Live-call control; used to hang up a call refused at the limit. */
    monitor?: { controlUrl?: string };
  };
}

function badRequest(message: string, status: number): NextResponse {
  return NextResponse.json({ error: { message } }, { status });
}

function authorize(request: Request): boolean {
  const expected = process.env.VAPI_WEBHOOK_SECRET?.trim();
  if (!expected) return false;
  // URLSearchParams decodes, so compare with the raw secret.
  const provided = new URL(request.url).searchParams.get("s")?.trim() ?? "";
  return provided.length > 0 && provided === expected;
}

async function findContactByPhone(
  subAccountId: string,
  phone: string,
): Promise<Contact | null> {
  const snap = await getAdminDb()
    .collection("contacts")
    .where("subAccountId", "==", subAccountId)
    .where("phone", "==", phone)
    .limit(1)
    .get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...(doc.data() as Omit<Contact, "id">) };
}

function openAiCompletion(text: string, model: string): unknown {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

/**
 * Last line of defence before TTS: strip [[capture]]/[[form]] markers,
 * markdown asterisks and bracket fragments that the voice rails forbid but
 * the model sometimes emits anyway.
 */
function stripVoiceUnspeakables(text: string): string {
  return (
    text
      .replace(/\[\[[^\]]*\]\]/g, "")
      // Leftovers from an unclosed marker.
      .replace(/\[\[/g, "")
      .replace(/\]\]/g, "")
      // TTS would say "asterisk asterisk".
      .replace(/\*\*/g, "")
      .replace(/(?<!\w)\*(?!\w)/g, "")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/**
 * OpenAI-format SSE, which Vapi expects for custom-LLM. We have no token
 * stream from OpenRouter, so it's one content chunk, a stop chunk and
 * [DONE]. Latency is dominated by the LLM call anyway.
 */
function openAiSseStream(text: string, model: string): Response {
  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta: Record<string, unknown>, finish: string | null) =>
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;

  const body =
    chunk({ role: "assistant", content: text }, null) +
    chunk({}, "stop") +
    "data: [DONE]\n\n";

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ subAccountId: string }> },
) {
  if (!authorize(request)) {
    // Most common cause of "custom-llm 500": the assistant's ?s= doesn't match
    // VAPI_WEBHOOK_SECRET (stale secret, or it points at another deployment).
    // Re-saving Voice settings re-PATCHes the assistant.
    const provided = new URL(request.url).searchParams.get("s");
    const expected = process.env.VAPI_WEBHOOK_SECRET?.trim();
    console.warn(
      `[vapi/llm] 401 — webhook secret mismatch. providedSecret=${
        provided ? "present" : "MISSING"
      } serverSecretConfigured=${expected ? "yes" : "NO"} ` +
        `match=${provided?.trim() === expected}. ` +
        `Re-save Voice settings to re-point the assistant.`,
    );
    return badRequest("Unauthorized", 401);
  }

  const { subAccountId } = await ctx.params;

  let body: VapiLlmBody;
  try {
    body = (await request.json()) as VapiLlmBody;
  } catch {
    return badRequest("Invalid JSON body", 400);
  }

  // Any unexpected throw below becomes a spoken fallback with 200 instead of
  // a 500 that drops the call. Auth/config short-circuits still return their
  // own status codes.
  const wantsStream = body.stream !== false;
  try {
  const agent = await resolveAgent(subAccountId, "voice");
  if (!agent) {
    return badRequest("Voice channel not configured for this sub-account", 404);
  }
  if (!agent.effective.enabled) {
    return badRequest("Voice channel is disabled for this sub-account", 403);
  }
  if (!agent.effective.systemPrompt.trim()) {
    return badRequest("Voice channel has no persona configured", 503);
  }

  const saSnap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  if (!saSnap.exists) return badRequest("Sub-account not found", 404);
  const subAccount = saSnap.data() as SubAccountDoc;

  // Turning the agency gate off doesn't tear down a provisioned assistant, so
  // re-check on every turn. Inbound and outbound have separate gates.
  const isOutboundCall = body.call?.metadata?.direction === "outbound";
  // Inbound voice is opt-out (only an explicit false locks it); outbound is
  // opt-in (=== true).
  const voiceGateOn = isOutboundCall
    ? subAccount.outboundVoiceEnabledByAgency === true
    : subAccount.inboundVoiceEnabledByAgency !== false;
  if (!voiceGateOn) {
    return badRequest(
      `${isOutboundCall ? "Outbound" : "Inbound"} voice is disabled for this sub-account by the agency`,
      403,
    );
  }

  // Only rebilled clients are limited, on the first turn so a live call is never
  // cut off. A refused call is marked so later turns keep refusing.
  const callerTurns = (body.messages ?? []).filter((m) => m.role === "user").length;
  const limitCallId = body.call?.id ?? null;
  const billing = isOutboundCall
    ? null
    : await getEffectiveBilling(subAccountId, subAccount).catch(() => null);
  if (billing?.rebilling) {
    const callRef = limitCallId
      ? getAdminDb().doc(`subAccounts/${subAccountId}/voiceCalls/${limitCallId}`)
      : null;
    let refused = false;
    if (callerTurns <= 1) {
      const quota = await checkQuota({ subAccountId, unit: "voiceSeconds", subAccount, billing });
      refused = !quota.allowed;
      if (refused && callRef) {
        await callRef.set({ limitBlocked: true }, { merge: true }).catch(() => {});
      }
    } else if (callRef) {
      refused = (await callRef.get().catch(() => null))?.data()?.limitBlocked === true;
    }
    if (refused) {
      const unavailable =
        "Sorry, we can't take calls right now. Please send us a text or try again later. Goodbye.";
      // Hang up once the line has been spoken; otherwise the caller's next turn
      // would no longer be a first turn and get through.
      const controlUrl = body.call?.monitor?.controlUrl;
      if (controlUrl) {
        runAfterResponse(async () => {
          await new Promise((r) => setTimeout(r, 8_000));
          await endCallViaControl(controlUrl);
        });
      }
      return wantsStream
        ? openAiSseStream(unavailable, "limit")
        : NextResponse.json(openAiCompletion(unavailable, "limit"));
    }
  }

  const callerPhone = body.call?.customer?.number?.trim() ?? "";
  const contact = callerPhone
    ? await findContactByPhone(subAccountId, callerPhone).catch(() => null)
    : null;

  const contextBlock = contact
    ? await buildContactContextBlock(contact).catch(() => null)
    : null;

  // Outbound calls (direction:"outbound" in metadata) use the outbound
  // persona when one is set; otherwise the shared persona.
  const outboundPersona = agent.channel.voice?.outboundSystemPrompt?.trim();
  const personaOverride =
    isOutboundCall && outboundPersona ? outboundPersona : null;

  let systemPrompt = buildSystemPrompt({
    agent,
    channelId: "voice",
    fallbackBusinessName: subAccount.name ?? "the business",
    contactContextBlock: contextBlock,
    personaOverride,
    bookingLink: subAccount.bookingLink ?? null,
  });

  // Live booking tools (inbound only). With a bookable page the agent can book;
  // with upcoming bookings for this caller it can also move or cancel them. An
  // unbookable page (missing, unpublished, deposit) falls back to the plain
  // booking link, so a page edit can't break live calls.
  let bookingPage: BookingPage | null = null;
  let changeable: ChangeTarget[] = [];
  if (!isOutboundCall) {
    const slugCfg = agent.channel.voice?.bookingPageSlug ?? null;
    if (slugCfg) {
      const bctx = await getAgentBookingContext(subAccountId, slugCfg).catch(
        () => null,
      );
      if (bctx?.bookable) {
        bookingPage = bctx.page;
      } else if (bctx) {
        console.warn(
          `[vapi/llm] booking page "${slugCfg}" not bookable (${bctx.reason}) sa=${subAccountId} — falling back to link behavior`,
        );
      }
    }
    // Caller ID identifies the contact but can be spoofed, so changes need
    // their own opt-in on top of the booking page.
    if (contact && slugCfg && agent.channel.voice?.allowCallerChanges === true) {
      changeable = toChangeTargets(
        await loadChangeableBookings({ subAccountId, contactId: contact.id }).catch(
          () => [],
        ),
      );
    }
  }
  const intake =
    bookingPage && agent.profile.bookingAskIntake === true && bookingPage.intakeFields.length > 0
      ? bookingPage.intakeFields
      : null;
  const toolsOn = bookingPage !== null || changeable.length > 0;
  if (toolsOn) {
    systemPrompt += `\n\n${buildBookingToolsBlock(bookingPage, "phone", { intake, changeable, knownPhone: !!callerPhone })}`;
  }

  // Drop Vapi's system message; keep the user/assistant history.
  const turns: AiChatMessage[] = (body.messages ?? [])
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: typeof m.content === "string" ? m.content : "",
    }))
    .filter((m) => m.content.length > 0);

  const messages: AiChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...turns,
  ];

  try {
    const callId = body.call?.id ?? null;
    const contactId = contact?.id ?? null;
    const changeKey = `phone:${contactId ?? callerPhone}`;
    // Only this caller's own bookings, re-checked inside the change transaction.
    const guard = (event: { subAccountId: string; contactId?: string | null }) =>
      !!contactId && event.subAccountId === subAccountId && event.contactId === contactId;
    const page = bookingPage;
    // Up to 2 booking-tool rounds after the first call. Without tools or a
    // marker it's exactly one LLM call.
    const result = await callAiWithBookingTools({
      messages,
      ai: {
        model: agent.effective.modelOverride ?? body.model ?? undefined,
        // Keep replies short; callers interrupt paragraphs.
        maxTokens: 220,
        temperature: 0.5,
      },
      tools: toolsOn
        ? {
            audience: "phone",
            subAccountId,
            page,
            intake,
            changeable,
            knownPhone: !!callerPhone,
            book: async (req) =>
              page
                ? bookAgentSlot({
                    subAccountId,
                    agencyId: subAccount.agencyId,
                    page,
                    channel: "phone",
                    startAtIso: req.startAtIso,
                    name: req.name,
                    phone: callerPhone,
                    email: contact?.email ?? null,
                    contactId,
                    hostUid: req.hostUid,
                    callId,
                    intakeAnswers: req.intakeAnswers,
                    address: req.address,
                    locationPhone: req.phone,
                  })
                : { ok: false, code: "error" },
            cancel: async (target) => {
              if (!canChangeBooking(changeKey)) return { ok: false, code: "limit" };
              const r = await cancelBooking({
                eventId: target.booking.eventId,
                guard,
                note: "by attendee on a call with the AI voice agent",
              });
              if (r.ok) countBookingChange(changeKey);
              return r.ok ? { ok: true } : r;
            },
            reschedule: async (target, startAtIso) => {
              if (!canChangeBooking(changeKey)) return { ok: false, code: "limit" };
              const r = await rescheduleBooking({
                eventId: target.booking.eventId,
                newStart: new Date(startAtIso),
                newEnd: null,
                guard,
              });
              if (r.ok) countBookingChange(changeKey);
              return r.ok ? { ok: true } : r;
            },
            onAttempt: () =>
              runAfterResponse(() => stampBookingAttempt(subAccountId, callId)),
          }
        : null,
      // Vapi history only carries what was spoken, so offers can't be replayed;
      // the transactional re-check guards every time instead.
      allowedKeys: null,
      // The route speaks its own "could you say that again?" when nothing is left.
      emptyReplyFallback: "",
      subAccountId,
      costSource: "voice",
    });
    const modelUsed = result.model;

    runAfterResponse(() => incrementChannelTokens(subAccountId, "voice", result.totalTokens));

    // TTS reads symbols out character by character, so strip markers and
    // asterisks here (voice only; chat/SMS keep their marker parsing). Also
    // catches a marker left over when the tool loop runs out of rounds.
    const speakable =
      stripVoiceUnspeakables(result.text) ||
      "Sorry, could you say that again?";

    return wantsStream
      ? openAiSseStream(speakable, modelUsed)
      : NextResponse.json(openAiCompletion(speakable, modelUsed));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(
      `[vapi/llm] LLM call failed sa=${subAccountId}: ${msg}`,
    );
    // 200 so Vapi doesn't play its own, worse-sounding error.
    const fallbackText =
      "Sorry, I'm having trouble hearing you. Could you say that again?";
    const fallbackModel = agent.effective.modelOverride ?? "fallback";
    return wantsStream
      ? openAiSseStream(fallbackText, fallbackModel)
      : NextResponse.json(openAiCompletion(fallbackText, fallbackModel));
  }
  } catch (outerErr) {
    // Unexpected throw outside the LLM call (resolveAgent, Firestore, prompt
    // build). Log with stack and degrade so the call doesn't drop.
    console.error(
      `[vapi/llm] UNHANDLED error sa=${subAccountId} —`,
      outerErr,
    );
    const fallbackText =
      "Sorry, I'm having a bit of trouble right now. Could you say that again?";
    return wantsStream
      ? openAiSseStream(fallbackText, "fallback")
      : NextResponse.json(openAiCompletion(fallbackText, "fallback"));
  }
}

/**
 * Flags on voiceCalls that the caller tried to book, so end-of-call can
 * create a call-back task if no booking completed (a caller mid-booking
 * never triggers Vapi's `callbackRequested`). Separate from the `booked`
 * stamp so a merge can't clobber a success. Best-effort.
 */
async function stampBookingAttempt(
  subAccountId: string,
  callId: string | null,
): Promise<void> {
  if (!callId) return;
  try {
    await getAdminDb()
      .doc(`subAccounts/${subAccountId}/voiceCalls/${callId}`)
      .set(
        { voiceBooking: { attemptedAt: new Date().toISOString() } },
        { merge: true },
      );
  } catch (err) {
    console.warn(`[vapi/llm] booking-attempt stamp failed sa=${subAccountId}`, err);
  }
}
