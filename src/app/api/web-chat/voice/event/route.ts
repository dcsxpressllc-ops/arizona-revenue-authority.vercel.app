import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { appendMessage } from "@/lib/comms/web-chat/session";
import { readWebVoiceConnection } from "@/lib/server/web-voice-service";
import { markConnected, settleConversation } from "@/lib/server/web-voice-usage";
import { verifySessionToken } from "@/lib/web-voice/tokens";
import type { SubAccountDoc } from "@/types";

export const dynamic = "force-dynamic";

/**
 * POST /api/web-chat/voice/event { token, type, conversationId }: lifecycle
 * pings from the chat iframe.
 * connected: ElevenLabs assigned a conversation id. Claim the grant reserved
 * at /start (once) and write the spoken greeting into the transcript.
 * ended: settle minutes. Also sent by sendBeacon on page hide, so the body
 * may be text/plain. Duration always comes from ElevenLabs; if it isn't
 * final yet, the next /start sweeps it.
 * The /start session token is the credential (sub-account, session, grant).
 */

const CONVERSATION_ID_RE = /^[A-Za-z0-9_-]{6,128}$/;

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
  let body: { token?: unknown; type?: unknown; conversationId?: unknown };
  try {
    body = JSON.parse(await request.text()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers });
  }

  const claims = verifySessionToken(body.token);
  const conversationId =
    typeof body.conversationId === "string" ? body.conversationId : "";
  if (!claims || !CONVERSATION_ID_RE.test(conversationId)) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400, headers });
  }

  try {
    if (body.type === "connected") {
      const fresh = await markConnected({
        subAccountId: claims.subAccountId,
        grantId: claims.grantId,
        conversationId,
        sessionId: claims.sessionId,
      });
      if (fresh) {
        const [conn, saSnap] = await Promise.all([
          readWebVoiceConnection(claims.subAccountId),
          getAdminDb().doc(`subAccounts/${claims.subAccountId}`).get(),
        ]);
        const sub = saSnap.data() as SubAccountDoc | undefined;
        if (conn?.greeting && sub?.agencyId) {
          await appendMessage({
            subAccountId: claims.subAccountId,
            agencyId: sub.agencyId,
            sessionId: claims.sessionId,
            direction: "outbound",
            body: conn.greeting,
            tokens: null,
            aiGenerated: true,
            via: "voice",
          });
        }
      }
    } else if (body.type === "ended") {
      const conn = await readWebVoiceConnection(claims.subAccountId);
      if (conn) {
        await settleConversation({
          subAccountId: claims.subAccountId,
          conversationId,
          conn,
          maxCallSeconds: conn.maxCallSeconds,
        });
      }
    } else {
      return NextResponse.json({ error: "Unknown event" }, { status: 400, headers });
    }
  } catch (err) {
    console.warn(
      `[web-voice/event] ${String(body.type)} failed sa=${claims.subAccountId}`,
      err,
    );
  }
  return NextResponse.json({ ok: true }, { status: 200, headers });
}
