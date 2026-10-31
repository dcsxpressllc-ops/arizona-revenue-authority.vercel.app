import "server-only";

import { NextResponse } from "next/server";
import { handleVapiEndOfCall } from "@/lib/comms/voice/end-of-call";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Vapi end-of-call webhook, sent once per call after Vapi's post-call
 * analysis (summary + structured data). Creates the contact, task,
 * escalation email and voiceCalls summary. Payload is
 * `{ message: { type: "end-of-call-report", ... } }`; status events go to
 * a separate endpoint.
 *
 * Always 200: Vapi retries 5xx and a retry would duplicate tasks/emails.
 * Errors are logged and returned in the JSON.
 */

interface VapiTurnRecord {
  role?: string;
  /** Newer shape uses `message`, older/artifact uses `content`. */
  message?: string;
  content?: string;
  time?: number;
  secondsFromStart?: number;
  endTime?: number;
}

interface VapiServerMessage {
  message?: {
    type?: string;
    call?: {
      id?: string;
      customer?: { number?: string };
      phoneNumber?: { number?: string };
      /** Stamped via assistantOverrides on outbound calls; Vapi echoes it back. */
      metadata?: {
        direction?: string;
        contactId?: string;
        campaignId?: string;
        test?: string;
      };
    };
    durationSeconds?: number;
    summary?: string;
    endedReason?: string;
    /** Filled when `analysisPlan.structuredDataPlan.enabled` is true. */
    analysis?: {
      summary?: string;
      structuredData?: Record<string, unknown>;
    };
    /** Vapi has moved this around; `artifact.messages` is checked first. */
    messages?: VapiTurnRecord[];
    artifact?: {
      messages?: VapiTurnRecord[];
      transcript?: string;
    };
  };
}

function authorize(request: Request): boolean {
  const expected = process.env.VAPI_WEBHOOK_SECRET?.trim();
  if (!expected) return false;
  // Secret is in the URL; see authorize() in the LLM route.
  const provided = new URL(request.url).searchParams.get("s")?.trim() ?? "";
  return provided.length > 0 && provided === expected;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function asBool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

/**
 * Normalise transcript turns from `artifact.messages` or `message.messages`
 * (field `message` or `content`). Drops system/tool/function turns.
 */
function extractTranscript(
  message: NonNullable<VapiServerMessage["message"]>,
): Array<{
  role: "assistant" | "user" | "system";
  content: string;
  secondsFromStart: number | null;
}> {
  const raw = message.artifact?.messages ?? message.messages ?? [];
  const out: Array<{
    role: "assistant" | "user" | "system";
    content: string;
    secondsFromStart: number | null;
  }> = [];
  for (const r of raw) {
    const role = (r.role ?? "").toLowerCase();
    if (role !== "user" && role !== "assistant" && role !== "bot" && role !== "system") {
      continue;
    }
    const normRole = role === "bot" ? "assistant" : (role as "user" | "assistant" | "system");
    const content =
      typeof r.message === "string"
        ? r.message
        : typeof r.content === "string"
          ? r.content
          : "";
    if (!content.trim()) continue;
    const secondsFromStart =
      typeof r.secondsFromStart === "number"
        ? r.secondsFromStart
        : typeof r.time === "number" && message.durationSeconds
          ? null
          : null;
    out.push({ role: normRole, content: content.trim(), secondsFromStart });
  }
  return out;
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ subAccountId: string }> },
) {
  if (!authorize(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { subAccountId } = await ctx.params;

  let body: VapiServerMessage;
  try {
    body = (await request.json()) as VapiServerMessage;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const message = body.message ?? {};
  if (message.type !== "end-of-call-report") {
    // Other event types belong to /status; accept quietly.
    return NextResponse.json({ ok: true, ignored: message.type ?? "unknown" });
  }

  const callId = asString(message.call?.id);
  if (!callId) {
    return NextResponse.json({ error: "Missing call.id" }, { status: 400 });
  }

  // Test calls from the Outbound settings page leave no trace.
  if (message.call?.metadata?.test === "1") {
    return NextResponse.json({ ok: true, ignored: "test_call" });
  }

  const structured = message.analysis?.structuredData ?? {};
  const transcript = extractTranscript(message);

  try {
    const result = await handleVapiEndOfCall({
      subAccountId,
      payload: {
        callId,
        callerPhone: asString(message.call?.customer?.number),
        toPhone: asString(message.call?.phoneNumber?.number),
        durationSec:
          typeof message.durationSeconds === "number"
            ? Math.max(0, Math.floor(message.durationSeconds))
            : 0,
        summary:
          asString(message.analysis?.summary) ?? asString(message.summary),
        endedReason: asString(message.endedReason),
        extracted: {
          name: asString(structured.name),
          email: asString(structured.email),
          phone: asString(structured.phone),
          callbackRequested: asBool(structured.callbackRequested),
          interested: asBool(structured.interested),
          interestReason: asString(structured.interestReason),
          reason: asString(structured.reason),
        },
        transcript,
        direction:
          message.call?.metadata?.direction === "outbound"
            ? "outbound"
            : undefined,
        metaContactId: asString(message.call?.metadata?.contactId),
        metaCampaignId: asString(message.call?.metadata?.campaignId),
      },
    });
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(
      `[vapi/end-of-call] handler failed sa=${subAccountId}: ${msg}`,
    );
    // Still 200 (retries would duplicate).
    return NextResponse.json({ ok: false, error: msg });
  }
}
