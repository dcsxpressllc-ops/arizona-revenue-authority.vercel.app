import "server-only";

import { randomBytes } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { aiChannelGateOn } from "@/lib/comms/ai/gates";
import { resolvedAppUrl } from "@/lib/server/website-handoff-service";
import {
  ElevenLabsError,
  createAgent,
  deleteAgent,
  listVoices,
  updateAgent,
  type AgentSpec,
  type ElevenLabsVoice,
} from "@/lib/web-voice/elevenlabs";
import {
  WEB_VOICE_DEFAULTS,
  WEB_VOICE_LANGUAGES,
  WEB_VOICE_LIMITS,
  webVoiceConnectionPath,
  webVoiceUsagePath,
  type WebVoiceConnectionSecret,
  type WebVoiceMeta,
  type WebVoiceSettings,
} from "@/types/web-voice";
import type { SubAccountDoc } from "@/types";

/**
 * Web Voice connection lifecycle: connect a key, provision/re-sync the private
 * ElevenLabs agent, update settings, disconnect. The only writer of the secret
 * doc; readers use readWebVoiceConnection. Provisioning is idempotent: re-sync
 * PATCHes the stored agent, and a 404 (deleted on ElevenLabs) re-creates it.
 */

export class WebVoiceError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "WebVoiceError";
  }
}

export async function readWebVoiceConnection(
  subAccountId: string,
): Promise<WebVoiceConnectionSecret | null> {
  const snap = await getAdminDb().doc(webVoiceConnectionPath(subAccountId)).get();
  if (!snap.exists) return null;
  const data = snap.data() as Partial<WebVoiceConnectionSecret>;
  if (!data.apiKey || !data.endpointSecret) return null;
  return {
    apiKey: data.apiKey,
    agentId: data.agentId ?? null,
    endpointSecret: data.endpointSecret,
    enabled: data.enabled !== false,
    voiceId: data.voiceId ?? "",
    voiceName: data.voiceName ?? "",
    language: data.language || WEB_VOICE_DEFAULTS.language,
    greeting: data.greeting || WEB_VOICE_DEFAULTS.greeting,
    maxCallSeconds: data.maxCallSeconds || WEB_VOICE_DEFAULTS.maxCallSeconds,
    dailyMinuteCap: data.dailyMinuteCap || WEB_VOICE_DEFAULTS.dailyMinuteCap,
  };
}

/** Show the mic: Web Voice and Web Chat gates on, provisioned, operator switch
 *  on. The daily cap is checked separately. */
export function webVoiceAvailable(sub: SubAccountDoc | null | undefined): boolean {
  if (!sub) return false;
  if (sub.webVoiceEnabledByAgency !== true) return false;
  if (!aiChannelGateOn(sub, "web-chat")) return false;
  const meta = sub.webVoiceMeta;
  return !!meta && meta.ready === true && meta.enabled !== false;
}

/** Throws WebVoiceError(400) on bad input. */
export function sanitizeSettings(
  patch: Partial<WebVoiceSettings>,
  base: WebVoiceSettings,
): WebVoiceSettings {
  const next: WebVoiceSettings = { ...base };
  if (patch.enabled !== undefined) next.enabled = patch.enabled === true;
  if (patch.voiceId !== undefined) {
    const v = String(patch.voiceId).trim();
    if (!/^[A-Za-z0-9_-]{4,64}$/.test(v)) {
      throw new WebVoiceError("Pick a voice from the list.", 400);
    }
    next.voiceId = v;
  }
  if (patch.voiceName !== undefined) {
    next.voiceName = String(patch.voiceName).trim().slice(0, 80);
  }
  if (patch.language !== undefined) {
    const code = String(patch.language).trim();
    if (!WEB_VOICE_LANGUAGES.some((l) => l.code === code)) {
      throw new WebVoiceError("Pick a language from the list.", 400);
    }
    next.language = code;
  }
  if (patch.greeting !== undefined) {
    const g = String(patch.greeting).trim();
    if (!g) throw new WebVoiceError("The spoken greeting can't be empty.", 400);
    next.greeting = g.slice(0, WEB_VOICE_LIMITS.greetingMaxChars);
  }
  if (patch.maxCallSeconds !== undefined) {
    const n = Math.round(Number(patch.maxCallSeconds));
    if (!Number.isFinite(n)) throw new WebVoiceError("Max call length must be a number.", 400);
    next.maxCallSeconds = Math.min(
      WEB_VOICE_LIMITS.maxCallSecondsMax,
      Math.max(WEB_VOICE_LIMITS.maxCallSecondsMin, n),
    );
  }
  if (patch.dailyMinuteCap !== undefined) {
    const n = Math.round(Number(patch.dailyMinuteCap));
    if (!Number.isFinite(n)) throw new WebVoiceError("Daily minute cap must be a number.", 400);
    next.dailyMinuteCap = Math.min(
      WEB_VOICE_LIMITS.dailyMinuteCapMax,
      Math.max(WEB_VOICE_LIMITS.dailyMinuteCapMin, n),
    );
  }
  return next;
}

function settingsOf(conn: WebVoiceConnectionSecret): WebVoiceSettings {
  return {
    enabled: conn.enabled,
    voiceId: conn.voiceId,
    voiceName: conn.voiceName,
    language: conn.language,
    greeting: conn.greeting,
    maxCallSeconds: conn.maxCallSeconds,
    dailyMinuteCap: conn.dailyMinuteCap,
  };
}

/** The secret is a path segment, not a query param, because ElevenLabs may
 *  append /chat/completions. The route is a catch-all. */
async function llmUrlFor(subAccountId: string, endpointSecret: string): Promise<string> {
  const appUrl = await resolvedAppUrl();
  if (!appUrl) {
    throw new WebVoiceError(
      "Web Voice needs a public https deployment (NEXT_PUBLIC_APP_URL) so ElevenLabs can reach it. It can't run on localhost.",
      503,
    );
  }
  return `${appUrl}/api/webhooks/elevenlabs/llm/${subAccountId}/${endpointSecret}`;
}

async function agentSpecFor(
  subAccountId: string,
  conn: WebVoiceConnectionSecret,
): Promise<AgentSpec> {
  const db = getAdminDb();
  const [subSnap, profileSnap] = await Promise.all([
    db.doc(`subAccounts/${subAccountId}`).get(),
    db.doc(`subAccounts/${subAccountId}/aiAgent/profile`).get(),
  ]);
  const businessName =
    (profileSnap.data()?.businessName as string | undefined)?.trim() ||
    (subSnap.data()?.name as string | undefined)?.trim() ||
    "Website";
  return {
    name: `${businessName} — website voice`.slice(0, 120),
    llmUrl: await llmUrlFor(subAccountId, conn.endpointSecret),
    voiceId: conn.voiceId,
    language: conn.language,
    greeting: conn.greeting,
    maxCallSeconds: conn.maxCallSeconds,
    concurrency: WEB_VOICE_LIMITS.concurrency,
  };
}

/** Create/update the agent and mirror the result onto the secret (agentId) and
 *  meta (ready / lastError). ElevenLabs failures are recorded, not thrown. */
async function syncAgent(
  subAccountId: string,
  conn: WebVoiceConnectionSecret,
  keyLast4: string,
  connectedAt: Date | null,
): Promise<WebVoiceMeta> {
  const db = getAdminDb();
  let agentId = conn.agentId;
  let lastError: string | null = null;
  try {
    const spec = await agentSpecFor(subAccountId, conn);
    if (agentId) {
      try {
        await updateAgent(conn.apiKey, agentId, spec);
      } catch (err) {
        if (err instanceof ElevenLabsError && err.status === 404) {
          agentId = await createAgent(conn.apiKey, spec);
        } else {
          throw err;
        }
      }
    } else {
      agentId = await createAgent(conn.apiKey, spec);
    }
  } catch (err) {
    lastError =
      err instanceof ElevenLabsError || err instanceof WebVoiceError
        ? err.message
        : "Couldn't set up the voice agent. Try saving again.";
    if (!(err instanceof ElevenLabsError || err instanceof WebVoiceError)) {
      console.error(`[web-voice] agent sync failed sa=${subAccountId}`, err);
    }
  }

  const meta: WebVoiceMeta = {
    ...settingsOf(conn),
    ready: !!agentId && !lastError,
    keyLast4,
    lastError,
    connectedAt,
  };
  await db.doc(webVoiceConnectionPath(subAccountId)).set(
    { ...conn, agentId: agentId ?? null },
    { merge: false },
  );
  await db.doc(`subAccounts/${subAccountId}`).set(
    { webVoiceMeta: meta, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
  return meta;
}

/** First "premade" voice, else the first one. */
function defaultVoice(voices: ElevenLabsVoice[]): ElevenLabsVoice | null {
  return voices.find((v) => v.category === "premade") ?? voices[0] ?? null;
}

/** Connect or replace the key. Listing voices validates it first; settings
 *  survive a re-key. */
export async function connectWebVoice(input: {
  subAccountId: string;
  apiKey: string;
}): Promise<{ meta: WebVoiceMeta; voices: ElevenLabsVoice[] }> {
  const apiKey = input.apiKey.trim();
  if (apiKey.length < 20 || /\s/.test(apiKey)) {
    throw new WebVoiceError(
      "That doesn't look like an ElevenLabs API key. Copy it from ElevenLabs → Developers → API keys.",
      400,
    );
  }

  let voices: ElevenLabsVoice[];
  try {
    voices = await listVoices(apiKey);
  } catch (err) {
    if (err instanceof ElevenLabsError) {
      throw new WebVoiceError(
        err.status === 401 || err.status === 403
          ? "ElevenLabs rejected that key. Check it has access to Voices and ElevenAgents (Conversational AI)."
          : err.message,
        err.status === 502 ? 502 : 400,
      );
    }
    throw err;
  }

  const existing = await readWebVoiceConnection(input.subAccountId);
  // A new key may be another ElevenLabs account, so the old agent can't be reused.
  // Best-effort delete on the old account.
  if (existing?.agentId && existing.apiKey !== apiKey) {
    await deleteAgent(existing.apiKey, existing.agentId).catch(() => {});
  }
  const keepAgent = existing && existing.apiKey === apiKey ? existing.agentId : null;

  const base: WebVoiceSettings = existing
    ? settingsOf(existing)
    : { ...WEB_VOICE_DEFAULTS, voiceId: "", voiceName: "" };
  // Keep the stored voice only if this account can see it.
  if (!voices.some((v) => v.voiceId === base.voiceId)) {
    const v = defaultVoice(voices);
    if (!v) {
      throw new WebVoiceError(
        "This ElevenLabs account has no voices yet. Add one from the Voice Library, then connect again.",
        400,
      );
    }
    base.voiceId = v.voiceId;
    base.voiceName = v.name;
  }

  const conn: WebVoiceConnectionSecret = {
    ...base,
    apiKey,
    agentId: keepAgent,
    endpointSecret: existing?.endpointSecret ?? randomBytes(24).toString("base64url"),
  };
  const meta = await syncAgent(input.subAccountId, conn, apiKey.slice(-4), new Date());
  return { meta, voices };
}

export async function updateWebVoiceSettings(input: {
  subAccountId: string;
  patch: Partial<WebVoiceSettings>;
}): Promise<WebVoiceMeta> {
  const conn = await readWebVoiceConnection(input.subAccountId);
  if (!conn) throw new WebVoiceError("Connect an ElevenLabs key first.", 400);
  const next = sanitizeSettings(input.patch, settingsOf(conn));
  const subSnap = await getAdminDb().doc(`subAccounts/${input.subAccountId}`).get();
  const prevMeta = (subSnap.data() as SubAccountDoc | undefined)?.webVoiceMeta;
  return syncAgent(
    input.subAccountId,
    { ...conn, ...next },
    prevMeta?.keyLast4 ?? conn.apiKey.slice(-4),
    prevMeta?.connectedAt ?? null,
  );
}

/** Live list for the picker; needs the stored key. */
export async function listWebVoiceVoices(subAccountId: string): Promise<ElevenLabsVoice[]> {
  const conn = await readWebVoiceConnection(subAccountId);
  if (!conn) return [];
  try {
    return await listVoices(conn.apiKey);
  } catch (err) {
    if (err instanceof ElevenLabsError) throw new WebVoiceError(err.message, 502);
    throw err;
  }
}

/** Deletes the agent (best-effort), secret and usage docs, and clears meta. */
export async function disconnectWebVoice(subAccountId: string): Promise<void> {
  const db = getAdminDb();
  const conn = await readWebVoiceConnection(subAccountId);
  if (conn?.agentId) {
    await deleteAgent(conn.apiKey, conn.agentId).catch((err) => {
      console.warn(`[web-voice] agent delete failed sa=${subAccountId}`, err);
    });
  }
  await Promise.all([
    db.doc(webVoiceConnectionPath(subAccountId)).delete(),
    db.doc(webVoiceUsagePath(subAccountId)).delete(),
  ]);
  await db.doc(`subAccounts/${subAccountId}`).set(
    { webVoiceMeta: null, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
}
