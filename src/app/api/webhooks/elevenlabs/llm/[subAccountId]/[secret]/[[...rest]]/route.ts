import "server-only";

import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { respondToWebChat } from "@/lib/comms/web-chat/respond";
import { runAfterResponse } from "@/lib/server/after-response";
import {
  readWebVoiceConnection,
  webVoiceAvailable,
} from "@/lib/server/web-voice-service";
import { verifySessionToken } from "@/lib/web-voice/tokens";
import { jsonReply, sseReply, streamingSseReply, toSpeakable } from "@/lib/web-voice/speech";
import type { SubAccountDoc } from "@/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * ElevenLabs custom-LLM endpoint for Web Voice. ElevenLabs POSTs an
 * OpenAI-style chat completion on every spoken turn; we answer through the
 * same pipeline as typed chat (respondToWebChat in voice mode), so persona,
 * KB, hours, escalation, lead capture, inbox mirroring and AI controls all
 * apply.
 *
 * URL: /api/webhooks/elevenlabs/llm/{subAccountId}/{endpointSecret}[/...]
 * (the tail swallows whatever ElevenLabs appends, e.g. /chat/completions).
 * The path secret must match the sub-account's endpointSecret, and
 * `elevenlabs_extra_body.token` must be a session token from /voice/start.
 *
 * Their system prompt and history are ignored; the Firestore transcript is
 * the source of truth and only the latest utterance is read. Failures
 * return 200 with a short spoken line instead of a dead call. The reply
 * streams so a slow turn (such as a booking) can't trip ElevenLabs' timeout.
 */

interface LlmBody {
  messages?: Array<{ role?: string; content?: unknown }>;
  stream?: boolean;
  elevenlabs_extra_body?: { token?: unknown } | null;
}

const MODEL = "web-voice";
const UNAVAILABLE =
  "Sorry, voice chat isn't available right now. You can type your message in the chat instead.";
const SAY_AGAIN = "Sorry, I didn't catch that. Could you say it again?";
const TROUBLE = "Sorry, I'm having a bit of trouble right now. Could you say that again?";
const FILLER = "One moment.";
const HELD =
  "Thanks! Someone from our team is looking after this conversation and will reply in the chat shortly.";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** String content or a content-part array. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof (p as { text?: unknown })?.text === "string" ? (p as { text: string }).text : ""))
      .join(" ");
  }
  return "";
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ subAccountId: string; secret: string; rest?: string[] }> },
) {
  const { subAccountId, secret } = await ctx.params;

  const conn = await readWebVoiceConnection(subAccountId).catch(() => null);
  if (!conn || !safeEqual(secret, conn.endpointSecret)) {
    console.warn(`[web-voice/llm] 401 — endpoint secret mismatch sa=${subAccountId}`);
    return NextResponse.json({ error: { message: "Unauthorized" } }, { status: 401 });
  }

  let body: LlmBody;
  try {
    body = (await request.json()) as LlmBody;
  } catch {
    return NextResponse.json({ error: { message: "Invalid JSON body" } }, { status: 400 });
  }
  const reply = (text: string) =>
    body.stream === false ? jsonReply(text, MODEL) : sseReply(text, MODEL);

  try {
    const claims = verifySessionToken(body.elevenlabs_extra_body?.token);
    if (!claims || claims.subAccountId !== subAccountId) {
      console.warn(
        `[web-voice/llm] missing/invalid session token sa=${subAccountId} — is "custom LLM extra body" enabled on the agent? Re-save Voice settings to re-sync.`,
      );
      return reply(UNAVAILABLE);
    }

    const saSnap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
    const sub = saSnap.exists ? (saSnap.data() as SubAccountDoc) : null;
    if (!sub || !webVoiceAvailable(sub)) return reply(UNAVAILABLE);

    const lastUser = [...(body.messages ?? [])]
      .reverse()
      .find((m) => m.role === "user" && contentText(m.content).trim());
    const utterance = lastUser ? contentText(lastUser.content).trim().slice(0, 2000) : "";
    if (!utterance) return reply(SAY_AGAIN);

    const produce = async (): Promise<string> => {
      const { outcome } = await respondToWebChat({
        subAccountId,
        agencyId: sub.agencyId,
        sessionId: claims.sessionId,
        incomingMessage: utterance,
        // /voice/start already created the session; these only matter if it didn't.
        pageUrl: null,
        referrer: null,
        origin: null,
        visitorIp: null,
        visitorUserAgent: null,
        mode: "voice",
      });
      let text: string;
      if (outcome.kind === "replied") text = outcome.replyText;
      else if (outcome.kind === "escalated") text = outcome.fallbackReply;
      else text = outcome.fallbackReply || HELD;
      return toSpeakable(text) || SAY_AGAIN;
    };

    if (body.stream === false) return jsonReply(await produce(), MODEL);
    const pending = produce().catch((err) => {
      console.error(`[web-voice/llm] UNHANDLED error sa=${subAccountId}`, err);
      return TROUBLE;
    });
    // A hang-up closes the stream; keep the function alive so a booking
    // already in progress finishes its writes.
    runAfterResponse(() => pending);
    return streamingSseReply(() => pending, MODEL, { filler: FILLER, fallback: TROUBLE });
  } catch (err) {
    console.error(`[web-voice/llm] UNHANDLED error sa=${subAccountId}`, err);
    return reply(TROUBLE);
  }
}
