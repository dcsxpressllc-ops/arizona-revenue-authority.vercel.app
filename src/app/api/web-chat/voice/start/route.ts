import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { getChannelConfig, resolveAgent } from "@/lib/comms/ai/agent";
import { isWithinBusinessHours } from "@/lib/comms/business-hours";
import { getOrCreateSession, isValidSessionId } from "@/lib/comms/web-chat/session";
import { getConversationControls } from "@/lib/server/conversations-service";
import {
  readWebVoiceConnection,
  webVoiceAvailable,
} from "@/lib/server/web-voice-service";
import {
  WebVoiceLimitError,
  reserveGrant,
  sweepStalePending,
} from "@/lib/server/web-voice-usage";
import { getSignedUrl } from "@/lib/web-voice/elevenlabs";
import { checkVoiceStart } from "@/lib/web-voice/rate-limit";
import { issueSessionToken, verifyWidgetToken } from "@/lib/web-voice/tokens";
import { ipFromRequest } from "@/lib/contacts/location";
import { checkQuota } from "@/lib/server/usage-meter";
import { webChatConversationId } from "@/types/conversations";
import type { SubAccountDoc } from "@/types";

export const dynamic = "force-dynamic";

/**
 * POST /api/web-chat/voice/start: the visitor tapped the mic. Public, called
 * from the chat iframe.
 *
 * Checks in order: widget token (minted by the origin-checked /config),
 * per-IP start limit, agency gates + connection ready + Web Chat enabled, no
 * human holding the conversation, stale-call sweep, daily minute cap and
 * concurrency (in a transaction), session exists. Then mints a 15-minute
 * signed URL on the client's ElevenLabs account and a session token the
 * browser passes to ElevenLabs as the custom-LLM extra body.
 *
 * `voiceEnabled:false` on an error hides the mic for the rest of the page
 * view (cap hit, feature off); other errors leave it for a retry.
 */

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
  const origin = request.headers.get("origin");
  const headers = corsHeaders(origin);
  const fail = (status: number, error: string, voiceEnabled = true, extra: Record<string, string> = {}) =>
    NextResponse.json({ error, voiceEnabled }, { status, headers: { ...headers, ...extra } });

  let body: {
    sa?: string;
    sessionId?: string;
    voiceToken?: string;
    pageUrl?: string;
    referrer?: string;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return fail(400, "Invalid JSON");
  }

  const subAccountId = body.sa?.trim() ?? "";
  const sessionId = body.sessionId?.trim();
  if (!subAccountId || !isValidSessionId(sessionId)) {
    return fail(400, "Missing sa or invalid sessionId");
  }
  if (!verifyWidgetToken(body.voiceToken, subAccountId)) {
    return fail(403, "Voice isn't available on this page.", false);
  }

  const ip = ipFromRequest(request) ?? "unknown";
  const rl = checkVoiceStart(ip);
  if (!rl.ok) {
    return fail(429, "Too many voice requests — please type instead.", true, {
      "Retry-After": String(rl.retryAfterSec),
    });
  }

  const saSnap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  const sub = saSnap.exists ? (saSnap.data() as SubAccountDoc) : null;
  if (!sub || !webVoiceAvailable(sub)) {
    return fail(403, "Voice isn't available right now.", false);
  }
  const channel = await getChannelConfig(subAccountId, "web-chat");
  if (!channel?.enabled) return fail(403, "Chat is offline.", false);

  // Outside hours the assistant only says "we're closed"; not worth voice
  // minutes when the typed chat already says it.
  const agent = await resolveAgent(subAccountId, "web-chat");
  if (
    agent &&
    !isWithinBusinessHours(
      agent.effective.hoursStart,
      agent.effective.hoursEnd,
      agent.effective.timezone,
    )
  ) {
    return fail(409, "We're closed right now — type your message and we'll get back to you.");
  }

  const conn = await readWebVoiceConnection(subAccountId);
  if (!conn?.agentId) return fail(503, "Voice isn't set up yet.", false);

  // A human owns the thread (AI off/paused); voice would talk over them.
  const controls = await getConversationControls(webChatConversationId(sessionId));
  const paused =
    controls.botPausedUntilMs !== null && controls.botPausedUntilMs > Date.now();
  if (controls.botMode !== "auto" || paused) {
    return fail(409, "A team member is handling this chat — please type your message.");
  }

  await sweepStalePending({ subAccountId, conn }).catch((err) => {
    console.warn(`[web-voice/start] stale sweep failed sa=${subAccountId}`, err);
  });

  // Monthly limit (or the spend ceiling) is checked here only, so a call is
  // never cut off mid-way. Fails open.
  const quota = await checkQuota({ subAccountId, unit: "webVoiceSeconds", subAccount: sub });
  if (!quota.allowed) {
    return fail(429, "Voice is unavailable right now — please type your message.", false);
  }

  let grantId: string;
  try {
    grantId = await reserveGrant(subAccountId, conn);
  } catch (err) {
    if (err instanceof WebVoiceLimitError) {
      return fail(429, err.message, err.reason !== "daily_cap");
    }
    throw err;
  }

  const session = await getOrCreateSession({
    subAccountId,
    agencyId: sub.agencyId,
    sessionId,
    pageUrl: body.pageUrl?.slice(0, 500) ?? null,
    referrer: body.referrer?.slice(0, 500) ?? null,
    origin,
    visitorIp: ip,
    visitorUserAgent: request.headers.get("user-agent")?.slice(0, 500) ?? null,
  });

  const token = issueSessionToken({ subAccountId, sessionId, grantId });
  if (!token) {
    console.error("[web-voice/start] AUTOMATIONS_TOKEN_SECRET missing — can't mint session token");
    return fail(503, "Voice isn't available right now.", false);
  }

  let signedUrl: string;
  try {
    signedUrl = await getSignedUrl(conn.apiKey, conn.agentId);
  } catch (err) {
    console.warn(`[web-voice/start] signed URL failed sa=${subAccountId}`, err);
    return fail(502, "Couldn't start voice right now — please type instead.");
  }

  return NextResponse.json(
    {
      signedUrl,
      token,
      maxCallSeconds: conn.maxCallSeconds,
      // Times offered before the call; the widget only shows offers made after.
      offerBaselineKey: session.bookingOffer?.offeredAtMs ?? null,
    },
    { status: 200, headers },
  );
}
