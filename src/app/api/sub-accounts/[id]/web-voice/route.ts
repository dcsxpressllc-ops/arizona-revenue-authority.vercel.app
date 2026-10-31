import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import {
  WebVoiceError,
  connectWebVoice,
  disconnectWebVoice,
  listWebVoiceVoices,
  updateWebVoiceSettings,
  webVoiceAvailable,
} from "@/lib/server/web-voice-service";
import { getWebVoiceUsage } from "@/lib/server/web-voice-usage";
import { issueWidgetToken } from "@/lib/web-voice/tokens";
import type { SubAccountDoc } from "@/types";
import type { WebVoiceSettings } from "@/types/web-voice";

export const dynamic = "force-dynamic";

/**
 * ElevenLabs Web Voice connection (sub-account admins).
 * GET: gate, display meta, today's/month's minutes, `?voices=1` for the
 * live voice list, and a widget token for the "Preview widget" link.
 * POST { apiKey }: connect or replace (probed before storing).
 * PATCH { enabled?, voiceId?, voiceName?, language?, greeting?,
 * maxCallSeconds?, dailyMinuteCap? }: save and re-sync the agent.
 * DELETE: disconnect, best-effort deleting the agent. Ungated so a client
 * can always remove their key.
 * The key is never returned, only `keyLast4`.
 */

async function loadSub(subAccountId: string): Promise<SubAccountDoc | null> {
  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  return snap.exists ? (snap.data() as SubAccountDoc) : null;
}

function gateOff(): NextResponse {
  return NextResponse.json(
    {
      error:
        "Web Voice isn't enabled for this workspace. Ask your agency owner to turn it on.",
    },
    { status: 403 },
  );
}

function errorResponse(err: unknown, fallback: string): NextResponse {
  if (err instanceof WebVoiceError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  console.error(`[web-voice] ${fallback}`, err);
  return NextResponse.json({ error: fallback }, { status: 500 });
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const sub = await loadSub(subAccountId);
  if (!sub) return NextResponse.json({ error: "Sub-account not found" }, { status: 404 });

  const gateOn = sub.webVoiceEnabledByAgency === true;
  const meta = sub.webVoiceMeta ?? null;
  const wantVoices = new URL(request.url).searchParams.get("voices") === "1";

  let voices: Awaited<ReturnType<typeof listWebVoiceVoices>> = [];
  let voicesError: string | null = null;
  if (gateOn && meta && wantVoices) {
    try {
      voices = await listWebVoiceVoices(subAccountId);
    } catch (err) {
      voicesError = err instanceof Error ? err.message : "Couldn't load voices.";
    }
  }

  const usage = meta ? await getWebVoiceUsage(subAccountId) : null;

  return NextResponse.json({
    gateOn,
    webChatGateOn: sub.webChatEnabledByAgency !== false,
    meta,
    usage,
    voices,
    voicesError,
    previewToken: webVoiceAvailable(sub) ? issueWidgetToken(subAccountId) : null,
  });
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const sub = await loadSub(subAccountId);
  if (!sub) return NextResponse.json({ error: "Sub-account not found" }, { status: 404 });
  if (sub.webVoiceEnabledByAgency !== true) return gateOff();

  let body: { apiKey?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.apiKey !== "string" || !body.apiKey.trim()) {
    return NextResponse.json({ error: "Paste your ElevenLabs API key." }, { status: 400 });
  }

  try {
    const { meta, voices } = await connectWebVoice({ subAccountId, apiKey: body.apiKey });
    return NextResponse.json({ ok: true, meta, voices });
  } catch (err) {
    return errorResponse(err, "Couldn't connect ElevenLabs.");
  }
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const sub = await loadSub(subAccountId);
  if (!sub) return NextResponse.json({ error: "Sub-account not found" }, { status: 404 });
  if (sub.webVoiceEnabledByAgency !== true) return gateOff();

  let body: Partial<WebVoiceSettings>;
  try {
    body = (await request.json()) as Partial<WebVoiceSettings>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const patch: Partial<WebVoiceSettings> = {};
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  if (typeof body.voiceId === "string") patch.voiceId = body.voiceId;
  if (typeof body.voiceName === "string") patch.voiceName = body.voiceName;
  if (typeof body.language === "string") patch.language = body.language;
  if (typeof body.greeting === "string") patch.greeting = body.greeting;
  if (body.maxCallSeconds !== undefined) patch.maxCallSeconds = Number(body.maxCallSeconds);
  if (body.dailyMinuteCap !== undefined) patch.dailyMinuteCap = Number(body.dailyMinuteCap);

  try {
    const meta = await updateWebVoiceSettings({ subAccountId, patch });
    return NextResponse.json({ ok: true, meta });
  } catch (err) {
    return errorResponse(err, "Couldn't save voice settings.");
  }
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  try {
    await disconnectWebVoice(subAccountId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "Couldn't disconnect ElevenLabs.");
  }
}
