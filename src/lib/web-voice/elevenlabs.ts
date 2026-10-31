import "server-only";

/**
 * Minimal ElevenLabs REST client for Web Voice, plain fetch. Always uses the
 * sub-account's own API key so the client pays for their minutes.
 *
 *   GET    /v1/voices                               voice picker
 *   POST   /v1/convai/agents/create                 provision
 *   PATCH  /v1/convai/agents/{id}                   re-sync
 *   DELETE /v1/convai/agents/{id}                   disconnect
 *   GET    /v1/convai/conversation/get-signed-url   private session
 *   GET    /v1/convai/conversations/{id}            duration for metering
 */

const BASE = "https://api.elevenlabs.io";
const TIMEOUT_MS = 15_000;

export class ElevenLabsError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "ElevenLabsError";
  }
}

/** Handles `{detail: {message}}`, `{detail: "..."}` and 422 `{detail: [{msg}]}`. */
function errorMessage(body: unknown, status: number): string {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const msgs = detail
      .map((d) => (d as { msg?: string; loc?: unknown[] })?.msg)
      .filter(Boolean);
    if (msgs.length) return msgs.join("; ");
  }
  if (detail && typeof detail === "object") {
    const m = (detail as { message?: string }).message;
    if (m) return m;
  }
  if (status === 401) return "ElevenLabs rejected the API key.";
  return `ElevenLabs returned HTTP ${status}.`;
}

async function call<T>(
  apiKey: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        "xi-api-key": apiKey,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "network error";
    throw new ElevenLabsError(`Couldn't reach ElevenLabs (${msg}).`, 502);
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    throw new ElevenLabsError(errorMessage(json, res.status), res.status);
  }
  return json as T;
}

export interface ElevenLabsVoice {
  voiceId: string;
  name: string;
  category: string | null;
  /** e.g. "american · female · young", from labels. */
  description: string | null;
  previewUrl: string | null;
}

export async function listVoices(apiKey: string): Promise<ElevenLabsVoice[]> {
  const data = await call<{
    voices?: Array<{
      voice_id: string;
      name?: string;
      category?: string;
      labels?: Record<string, string>;
      preview_url?: string;
    }>;
  }>(apiKey, "GET", "/v1/voices");
  return (data.voices ?? [])
    .filter((v) => v.voice_id)
    .map((v) => ({
      voiceId: v.voice_id,
      name: v.name?.trim() || v.voice_id,
      category: v.category ?? null,
      description: v.labels
        ? Object.values(v.labels).filter(Boolean).slice(0, 4).join(" · ") ||
          null
        : null,
      previewUrl: v.preview_url ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface AgentSpec {
  name: string;
  /** LeadStack reply endpoint, secret in the path. */
  llmUrl: string;
  voiceId: string;
  language: string;
  greeting: string;
  maxCallSeconds: number;
  concurrency: number;
}

/**
 * Private agent (`enable_auth`) so only our signed URLs can start a session.
 * Custom LLM points back at LeadStack, with extra-body override on so the
 * widget can pass the session token to every reply request.
 */
function agentBody(spec: AgentSpec, legacyTts = false): Record<string, unknown> {
  // v4 Turbo is the most expressive real-time voice. Older accounts that refuse
  // it get flash, which ElevenLabs used to require (v2 for English, v2.5 otherwise).
  const ttsModel = legacyTts
    ? spec.language === "en"
      ? "eleven_flash_v2"
      : "eleven_flash_v2_5"
    : "eleven_v4_turbo";
  return {
    name: spec.name,
    tags: ["web-voice"],
    conversation_config: {
      agent: {
        first_message: spec.greeting,
        language: spec.language,
        prompt: {
          // Ignored by our endpoint; the persona comes from LeadStack.
          prompt: "You are a helpful assistant for a business website.",
          llm: "custom-llm",
          custom_llm: { url: spec.llmUrl, model_id: "web-voice" },
          temperature: 0.5,
          max_tokens: 300,
        },
      },
      tts: { voice_id: spec.voiceId, model_id: ttsModel },
      conversation: { max_duration_seconds: spec.maxCallSeconds },
    },
    platform_settings: {
      auth: { enable_auth: true },
      overrides: { custom_llm_extra_body: true },
      call_limits: { agent_concurrency_limit: spec.concurrency },
    },
  };
}

/** Retries once on the older flash model when ElevenLabs rejects the body. */
async function withTtsFallback<T>(send: (legacyTts: boolean) => Promise<T>): Promise<T> {
  try {
    return await send(false);
  } catch (err) {
    if (err instanceof ElevenLabsError && (err.status === 400 || err.status === 422)) {
      return send(true);
    }
    throw err;
  }
}

export async function createAgent(apiKey: string, spec: AgentSpec): Promise<string> {
  const data = await withTtsFallback((legacy) =>
    call<{ agent_id?: string }>(apiKey, "POST", "/v1/convai/agents/create", agentBody(spec, legacy)),
  );
  if (!data.agent_id) {
    throw new ElevenLabsError("ElevenLabs didn't return an agent id.", 502);
  }
  return data.agent_id;
}

export async function updateAgent(
  apiKey: string,
  agentId: string,
  spec: AgentSpec,
): Promise<void> {
  await withTtsFallback((legacy) =>
    call(apiKey, "PATCH", `/v1/convai/agents/${encodeURIComponent(agentId)}`, agentBody(spec, legacy)),
  );
}

export async function deleteAgent(apiKey: string, agentId: string): Promise<void> {
  await call(apiKey, "DELETE", `/v1/convai/agents/${encodeURIComponent(agentId)}`);
}

/** 15-minute signed WebSocket URL for one conversation. */
export async function getSignedUrl(apiKey: string, agentId: string): Promise<string> {
  const data = await call<{ signed_url?: string }>(
    apiKey,
    "GET",
    `/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`,
  );
  if (!data.signed_url) {
    throw new ElevenLabsError("ElevenLabs didn't return a signed URL.", 502);
  }
  return data.signed_url;
}

export interface ConversationSummary {
  agentId: string | null;
  status: string | null;
  durationSeconds: number | null;
}

export async function getConversation(
  apiKey: string,
  conversationId: string,
): Promise<ConversationSummary> {
  const data = await call<{
    agent_id?: string;
    status?: string;
    metadata?: { call_duration_secs?: number };
  }>(apiKey, "GET", `/v1/convai/conversations/${encodeURIComponent(conversationId)}`);
  const secs = data.metadata?.call_duration_secs;
  return {
    agentId: data.agent_id ?? null,
    status: data.status ?? null,
    durationSeconds: typeof secs === "number" && secs >= 0 ? secs : null,
  };
}
