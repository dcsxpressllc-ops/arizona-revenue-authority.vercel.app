import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { getChannelConfig } from "@/lib/comms/ai/agent";
import { aiChannelGateOn } from "@/lib/comms/ai/gates";
import { checkAndCount } from "@/lib/comms/web-chat/rate-limit";
import { isValidSessionId } from "@/lib/comms/web-chat/session";
import { respondToWebChat } from "@/lib/comms/web-chat/respond";
import { ipFromRequest } from "@/lib/contacts/location";
import type { SubAccountDoc } from "@/types";

export const dynamic = "force-dynamic";

/**
 * Widget message endpoint, hit on every visitor message.
 *
 * Deliberately no origin check: the calling iframe lives on our domain, so
 * Origin is always our own host. The domain allowlist is enforced at
 * /api/web-chat/config, which widget.js calls from the parent page where
 * Origin is the client's site. Here we gate on a real saId, channel
 * enabled, per-IP and per-session rate limits, and token budgets, which
 * makes direct abuse uneconomical.
 *
 * Errors still carry CORS headers so the visitor sees a fallback, not a
 * console CORS error.
 */

const MAX_MESSAGE_CHARS = 2000;

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

  let body: {
    sa?: string;
    sessionId?: string;
    message?: string;
    pageUrl?: string;
    referrer?: string;
    /** Start value of a time button the visitor tapped. */
    pickedSlot?: string;
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
  const message = body.message?.trim();

  if (!subAccountId) {
    return NextResponse.json(
      { error: "Missing sa" },
      { status: 400, headers },
    );
  }
  if (!isValidSessionId(sessionId)) {
    return NextResponse.json(
      { error: "Invalid sessionId" },
      { status: 400, headers },
    );
  }
  if (!message || message.length > MAX_MESSAGE_CHARS) {
    return NextResponse.json(
      { error: `Message must be 1-${MAX_MESSAGE_CHARS} characters` },
      { status: 400, headers },
    );
  }

  // Origin allowlist lives in /config, not here.
  const config = await getChannelConfig(subAccountId, "web-chat");
  if (!config || !config.enabled || !config.webChat) {
    return NextResponse.json(
      { enabled: false, error: "Web Chat is not enabled for this sub-account" },
      { status: 403, headers },
    );
  }

  // After auth, so rejected requests don't use IP budget.
  const ip = ipFromRequest(request) ?? "unknown";
  const rl = checkAndCount(ip, sessionId);
  if (!rl.ok) {
    return NextResponse.json(
      {
        error:
          rl.reason === "session-quota"
            ? "Session message limit reached"
            : "Too many requests — try again in a bit",
      },
      {
        status: 429,
        headers: { ...headers, "Retry-After": String(rl.retryAfterSec) },
      },
    );
  }

  // agencyId for tenancy stamps.
  const saSnap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  if (!saSnap.exists) {
    return NextResponse.json(
      { error: "Sub-account not found" },
      { status: 404, headers },
    );
  }
  const sa = saSnap.data() as SubAccountDoc;

  // Spends the agency's OpenRouter credits, so the agency must enable it.
  // Return {enabled:false} so the widget degrades quietly.
  if (!aiChannelGateOn(sa, "web-chat")) {
    return NextResponse.json(
      { enabled: false, error: "Web Chat is disabled for this sub-account" },
      { status: 403, headers },
    );
  }

  try {
    const { outcome, outboundMessageId, offline } = await respondToWebChat({
      subAccountId,
      agencyId: sa.agencyId,
      sessionId,
      incomingMessage: message,
      pageUrl: body.pageUrl?.slice(0, 500) ?? null,
      referrer: body.referrer?.slice(0, 500) ?? null,
      origin,
      visitorIp: ip,
      visitorUserAgent: request.headers.get("user-agent")?.slice(0, 500) ?? null,
      // Matched against the session's stored offer before it means anything.
      pickedSlotIso:
        typeof body.pickedSlot === "string" && body.pickedSlot.length <= 40
          ? body.pickedSlot
          : null,
    });

    // AI off / paused / suggest: a human has the thread and the bot stayed
    // quiet. The widget shows its one-time "connected" note instead.
    const held =
      outcome.kind === "skipped" &&
      (outcome.reason === "human_takeover" ||
        outcome.reason === "suggest_draft");
    if (held) {
      return NextResponse.json(
        {
          reply: null,
          kind: outcome.kind,
          held: true,
          // Outside hours the widget shows "offline" now; inside hours it waits.
          offline: offline ?? false,
          formFields: null,
        },
        { status: 200, headers },
      );
    }

    const visibleReply =
      outcome.kind === "replied"
        ? outcome.replyText
        : outcome.kind === "escalated"
          ? outcome.fallbackReply
          : outcome.fallbackReply;
    const formFields =
      outcome.kind === "replied" ? outcome.formFields : null;
    const slots = outcome.kind === "replied" ? outcome.slotButtons : null;

    return NextResponse.json(
      {
        reply: visibleReply,
        kind: outcome.kind,
        formFields,
        slots,
        // The widget records this so the poll loop doesn't render it twice.
        messageId: outboundMessageId,
      },
      { status: 200, headers },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(`[web-chat/message] sa=${subAccountId} failed:`, msg);
    return NextResponse.json(
      {
        reply:
          "Sorry — something went wrong on our end. The team has been notified.",
        kind: "skipped",
      },
      { status: 200, headers },
    );
  }
}
