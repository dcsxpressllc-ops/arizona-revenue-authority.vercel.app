import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { getChannelConfig } from "@/lib/comms/ai/agent";
import { aiChannelGateOn } from "@/lib/comms/ai/gates";
import { checkOriginAllowed } from "@/lib/comms/web-chat/origin";
import {
  readWebVoiceConnection,
  webVoiceAvailable,
} from "@/lib/server/web-voice-service";
import { webVoiceCapReached } from "@/lib/server/web-voice-usage";
import { issueWidgetToken } from "@/lib/web-voice/tokens";
import { DEFAULT_WEB_CHAT_CONFIG } from "@/types/ai";
import type { SubAccountDoc } from "@/types";

export const dynamic = "force-dynamic";

/**
 * Widget loader config (theme, welcome message, enabled), fetched on every
 * page load. Checks Origin against the channel's allowedDomains; a miss
 * still returns 200 with `{ enabled: false }` so the loader quietly turns
 * itself off instead of logging a CORS error on the client's site. Always
 * sends CORS headers.
 */

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
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

export async function GET(request: Request) {
  const url = new URL(request.url);
  const subAccountId = url.searchParams.get("sa");
  const origin = request.headers.get("origin");
  const headers = corsHeaders(origin);

  if (!subAccountId) {
    return NextResponse.json(
      { error: "Missing sa param" },
      { status: 400, headers },
    );
  }

  const config = await getChannelConfig(subAccountId, "web-chat");
  if (!config || !config.enabled || !config.webChat) {
    return NextResponse.json(
      { enabled: false },
      { status: 200, headers },
    );
  }

  // Agency gate off: report disabled, same as an origin miss. Only read the
  // sub doc once the channel itself is on.
  const saSnap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  const sa = saSnap.exists ? (saSnap.data() as SubAccountDoc) : null;
  if (!sa || !aiChannelGateOn(sa, "web-chat")) {
    return NextResponse.json({ enabled: false }, { status: 200, headers });
  }

  const originCheck = checkOriginAllowed(origin, config.webChat.allowedDomains);
  if (!originCheck.allowed) {
    return NextResponse.json(
      { enabled: false, reason: originCheck.reason },
      { status: 200, headers },
    );
  }

  // This is the origin-checked request, so it hands out the token
  // /voice/start needs. Hidden once today's minute cap is hit; any failure
  // just hides the mic.
  let voice: { voiceEnabled: boolean; voiceToken?: string } = { voiceEnabled: false };
  if (webVoiceAvailable(sa)) {
    try {
      const conn = await readWebVoiceConnection(subAccountId);
      if (conn?.agentId && !(await webVoiceCapReached(subAccountId, conn))) {
        const voiceToken = issueWidgetToken(subAccountId);
        if (voiceToken) voice = { voiceEnabled: true, voiceToken };
      }
    } catch (err) {
      console.warn(`[web-chat/config] voice check failed sa=${subAccountId}`, err);
    }
  }

  // Older docs may lack some fields; fall back to defaults.
  return NextResponse.json(
    {
      enabled: true,
      ...voice,
      welcomeMessage:
        config.webChat.welcomeMessage || DEFAULT_WEB_CHAT_CONFIG.welcomeMessage,
      accentColor:
        config.webChat.accentColor || DEFAULT_WEB_CHAT_CONFIG.accentColor,
      position: config.webChat.position || DEFAULT_WEB_CHAT_CONFIG.position,
    },
    { status: 200, headers },
  );
}
