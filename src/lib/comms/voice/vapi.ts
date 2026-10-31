import "server-only";

import type { AiAgentProfile, VoiceChannelConfig } from "@/types/ai";
import type { TwilioConfig } from "@/types";

/**
 * Thin Vapi REST wrapper. Vapi owns STT/TTS/turn-taking for calls; each LLM
 * turn is posted to /api/webhooks/vapi/llm/[saId] (custom-LLM mode), so voice
 * runs through the same resolveAgent/buildSystemPrompt/OpenRouter path as SMS
 * and web chat.
 *
 * Numbers are BYOC: we register the sub-account's existing Twilio number with
 * Vapi instead of renting one, so SMS and voice share a number and a bill.
 */

const VAPI_BASE_URL = "https://api.vapi.ai";

export class VapiError extends Error {
  status: number;
  body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = "VapiError";
    this.status = status;
    this.body = body;
  }
}

export function vapiIsConfigured(): boolean {
  return Boolean(
    process.env.VAPI_API_KEY?.trim() && process.env.VAPI_WEBHOOK_SECRET?.trim(),
  );
}

function getApiKey(): string {
  const key = process.env.VAPI_API_KEY?.trim();
  if (!key) {
    throw new VapiError("VAPI_API_KEY is not set", 500, "");
  }
  return key;
}

function getWebhookSecret(): string {
  const s = process.env.VAPI_WEBHOOK_SECRET?.trim();
  if (!s) {
    throw new VapiError("VAPI_WEBHOOK_SECRET is not set", 500, "");
  }
  return s;
}

/**
 * Public base URL Vapi calls back on. It gets baked into the assistant on every
 * provisioning save, so it must be the same reachable URL everywhere; a save
 * from local dev with NEXT_PUBLIC_APP_URL=localhost would repoint the live
 * assistant somewhere Vapi can't reach. Set VAPI_PUBLIC_BASE_URL to the prod
 * URL in both prod and dev; falls back to NEXT_PUBLIC_APP_URL.
 */
function getAppUrl(): string {
  const url = (
    process.env.VAPI_PUBLIC_BASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_APP_URL?.trim()
  );
  if (!url) {
    throw new VapiError(
      "Neither VAPI_PUBLIC_BASE_URL nor NEXT_PUBLIC_APP_URL is set — Vapi must reach our LLM endpoint",
      500,
      "",
    );
  }
  return url.replace(/\/$/, "");
}

async function vapiFetch<T>(
  path: string,
  init: RequestInit,
): Promise<T> {
  const res = await fetch(`${VAPI_BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getApiKey()}`,
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new VapiError(
      `Vapi ${init.method ?? "GET"} ${path} -> ${res.status}`,
      res.status,
      text.slice(0, 2000),
    );
  }
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new VapiError(
      `Vapi returned non-JSON for ${path}`,
      res.status,
      text.slice(0, 2000),
    );
  }
}

/**
 * Assistant config. "custom-llm" provider makes Vapi post chat completions to
 * our endpoint each turn; Vapi handles STT, TTS, VAD and barge-in, we own
 * persona/KB/escalation.
 */
interface VapiAssistantBody {
  name: string;
  firstMessage: string;
  /** Pinned. On an inbound call, silence reads as a dead line and callers hang up. */
  firstMessageMode: "assistant-speaks-first";
  endCallMessage: string;
  maxDurationSeconds: number;
  silenceTimeoutSeconds: number;
  /** Vapi defaults to office ambience, which sounds like an offshore call centre. */
  backgroundSound: "off";
  /** Recording pinned off, not a toggle: all-party-consent jurisdictions exist and
   *  there's no disclosure flow. Transcripts are unaffected. */
  artifactPlan: {
    recordingEnabled: false;
  };
  model: {
    provider: "custom-llm";
    model: string;
    url: string;
  };
  voice: {
    provider: string;
    voiceId: string;
    /** Omitted when not configured. */
    version?: string;
  };
  /** Omitted (Vapi default) unless the operator picked a transcriber. */
  transcriber?: {
    provider: string;
    model?: string;
  };
  server: {
    url: string;
    timeoutSeconds: number;
  };
  /** Without an explicit list Vapi's defaults can skip end-of-call-report (seen on
   *  web calls), and post-call extraction never runs. */
  serverMessages: Array<
    "end-of-call-report" | "status-update" | "hang" | "transcript"
  >;
  /** Declared here so Vapi doesn't swap in its dashboard defaults on our PATCHes,
   *  which would force a manual Publish after every settings edit. */
  analysisPlan: {
    structuredDataPlan: {
      enabled: boolean;
      schema: {
        type: "object";
        properties: Record<
          string,
          { type: string; description: string }
        >;
      };
      messages: Array<{ role: "system" | "user"; content: string }>;
    };
    summaryPlan: {
      enabled: boolean;
    };
  };
  metadata: Record<string, string>;
}

interface VapiAssistantResponse {
  id: string;
}

interface VapiPhoneNumberResponse {
  id: string;
}

function buildAssistantBody(input: {
  subAccountId: string;
  profile: AiAgentProfile;
  voice: VoiceChannelConfig;
  modelOverride: string | null;
}): VapiAssistantBody {
  const appUrl = getAppUrl();
  // Auth is a `?s=` secret in the URL. Vapi's server.secret sends X-Vapi-Secret
  // rather than a Bearer header, and custom-LLM model.url has no auth option at
  // all, so a query param is the one thing that works for all three endpoints.
  //
  // Vapi appends "/chat/completions" to the whole custom-llm URL, query string
  // included. The trailing `&_=` param soaks that up (`_=/chat/completions`) so
  // it doesn't corrupt `s=`. Harmless on the server URL, mirrored for symmetry.
  const secret = getWebhookSecret();
  const q = `?s=${encodeURIComponent(secret)}&_=`;
  const llmUrl = `${appUrl}/api/webhooks/vapi/llm/${input.subAccountId}${q}`;
  const serverUrl = `${appUrl}/api/webhooks/vapi/end-of-call/${input.subAccountId}${q}`;
  const defaultModel =
    input.modelOverride?.trim() ||
    process.env.AI_REPLIES_DEFAULT_MODEL?.trim() ||
    "anthropic/claude-haiku-4-5";

  return {
    // Vapi caps names at 40 chars.
    name: `LeadStack sa:${input.subAccountId}`.slice(0, 40),
    firstMessage: input.voice.greeting,
    firstMessageMode: "assistant-speaks-first",
    endCallMessage: "Talk soon. Bye.",
    maxDurationSeconds: input.voice.maxCallSeconds,
    silenceTimeoutSeconds: 20,
    backgroundSound: "off",
    artifactPlan: {
      recordingEnabled: false,
    },
    model: {
      provider: "custom-llm",
      // Hint only: our LLM endpoint overrides it from the live channel config.
      model: defaultModel,
      url: llmUrl,
    },
    voice: {
      provider: input.voice.voiceProvider,
      voiceId: input.voice.voiceId,
      ...(input.voice.voiceVersion?.trim()
        ? { version: input.voice.voiceVersion.trim() }
        : {}),
    },
    // Sent explicitly so the 404 re-create path can't reset the operator's STT choice.
    ...(input.voice.transcriberProvider?.trim()
      ? {
          transcriber: {
            provider: input.voice.transcriberProvider.trim(),
            ...(input.voice.transcriberModel?.trim()
              ? { model: input.voice.transcriberModel.trim() }
              : {}),
          },
        }
      : {}),
    server: {
      url: serverUrl,
      // Custom-LLM turns finish well under 5s; 20s (Vapi's UI default) covers cold
      // starts. Auth is the `?s=` param above, not server.secret.
      timeoutSeconds: 20,
    },
    // Vapi's default list omits end-of-call-report for some call types (web calls),
    // which would skip the post-call Contact/Task/email pipeline.
    serverMessages: ["end-of-call-report", "status-update", "hang"],
    analysisPlan: {
      structuredDataPlan: {
        enabled: true,
        // Vapi's UI default template, pinned so PATCHes don't leave the assistant in
        // "Unsaved changes" and need a manual Publish.
        messages: [
          {
            role: "system",
            content:
              "You are an expert data extractor. You will be given a transcript of a call. Extract structured data per the JSON Schema. DO NOT return anything except the structured data.\n\nJson Schema:\n{{schema}}\n\nOnly respond with the JSON.",
          },
          {
            role: "user",
            content:
              "Here is the transcript:\n\n{{transcript}}\n\n. Here is the ended reason of the call:\n\n{{endedReason}}\n\n",
          },
        ],
        schema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description:
                "Caller's name if shared during the call. Empty string if not given.",
            },
            email: {
              type: "string",
              description:
                "Caller's email if shared. Must be a valid email address. Empty string if not given.",
            },
            phone: {
              type: "string",
              description:
                "Callback phone number if the caller explicitly asked us to call back on a DIFFERENT number than the one they called from. Empty string otherwise.",
            },
            callbackRequested: {
              type: "boolean",
              description:
                "True if the caller asked for someone to call them back, false if they just had a question that was answered on the call.",
            },
            interested: {
              type: "boolean",
              description:
                "For an OUTBOUND call about an offer or program: true if the person expressed interest in signing up / learning more / being followed up about it. False if they declined, weren't interested, or it was an inbound enquiry. Default false when unsure.",
            },
            interestReason: {
              type: "string",
              description:
                "One short sentence on what they were interested in or why, e.g. 'Wants to join the 30-Day Challenge', 'Asked to be called back after payday'. Empty string if not interested.",
            },
            reason: {
              type: "string",
              description:
                "One sentence describing what the caller wanted. E.g. 'Quote for a kitchen renovation', 'Asked about Saturday opening hours'.",
            },
          },
        },
      },
      summaryPlan: {
        enabled: true,
      },
    },
    metadata: {
      subAccountId: input.subAccountId,
      source: "leadstack",
    },
  };
}

/**
 * Checks an operator-pasted Vapi phone-number id. Assistant and number ids are
 * both bare UUIDs, so a wrong paste otherwise saves fine and fails later.
 * False only on a definite 404; other errors count as reachable so a blip
 * isn't reported as "no such number".
 */
export async function vapiPhoneNumberExists(id: string): Promise<boolean> {
  try {
    await vapiFetch<VapiPhoneNumberResponse>(`/phone-number/${id}`, {
      method: "GET",
    });
    return true;
  } catch (err) {
    if (err instanceof VapiError && err.status === 404) return false;
    return true;
  }
}

/** Create-or-update the sub-account's assistant. Pass null to create fresh. Returns the id. */
export async function ensureVapiAssistant(input: {
  subAccountId: string;
  profile: AiAgentProfile;
  voice: VoiceChannelConfig;
  modelOverride: string | null;
  existingAssistantId: string | null;
}): Promise<{ assistantId: string }> {
  const body = buildAssistantBody({
    subAccountId: input.subAccountId,
    profile: input.profile,
    voice: input.voice,
    modelOverride: input.modelOverride,
  });

  if (input.existingAssistantId) {
    try {
      await vapiFetch<VapiAssistantResponse>(
        `/assistant/${input.existingAssistantId}`,
        {
          method: "PATCH",
          body: JSON.stringify(body),
        },
      );
      return { assistantId: input.existingAssistantId };
    } catch (err) {
      // Stored id is gone (deleted in the Vapi dashboard, region change): create fresh.
      if (err instanceof VapiError && err.status === 404) {
        console.warn(
          `[vapi] stored assistantId ${input.existingAssistantId} not found, re-creating`,
        );
      } else {
        throw err;
      }
    }
  }

  const created = await vapiFetch<VapiAssistantResponse>("/assistant", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return { assistantId: created.id };
}

/**
 * BYOC phone-number registration. Vapi treats Twilio creds as immutable on the
 * resource, so with an existing id we only update the assistant binding; cred
 * rotation means delete + re-create, which the channel save route handles.
 */
export async function ensureVapiPhoneNumber(input: {
  subAccountId: string;
  twilioConfig: TwilioConfig;
  assistantId: string;
  existingPhoneNumberId: string | null;
}): Promise<{ phoneNumberId: string }> {
  if (input.existingPhoneNumberId) {
    try {
      await vapiFetch(`/phone-number/${input.existingPhoneNumberId}`, {
        method: "PATCH",
        body: JSON.stringify({ assistantId: input.assistantId }),
      });
      return { phoneNumberId: input.existingPhoneNumberId };
    } catch (err) {
      if (err instanceof VapiError && err.status === 404) {
        console.warn(
          `[vapi] stored phoneNumberId ${input.existingPhoneNumberId} not found, re-registering`,
        );
      } else {
        throw err;
      }
    }
  }

  try {
    const created = await vapiFetch<VapiPhoneNumberResponse>("/phone-number", {
      method: "POST",
      body: JSON.stringify({
        provider: "twilio",
        number: input.twilioConfig.fromNumber,
        twilioAccountSid: input.twilioConfig.accountSid,
        twilioAuthToken: input.twilioConfig.authToken,
        assistantId: input.assistantId,
        name: `LeadStack sa:${input.subAccountId}`.slice(0, 40),
      }),
    });
    return { phoneNumberId: created.id };
  } catch (err) {
    // Vapi 400s ("Existing Phone Number ... Has Identical twilioAccountSid and
    // number") when the number is already registered but we lost our stored id.
    // Find the resource by number and rebind instead of failing the save.
    if (
      err instanceof VapiError &&
      err.status === 400 &&
      /identical|existing phone number|already/i.test(err.body)
    ) {
      const existingId = await findVapiPhoneNumberIdByNumber(
        input.twilioConfig.fromNumber,
      );
      if (existingId) {
        console.warn(
          `[vapi] phone-number ${input.twilioConfig.fromNumber} already registered — rebinding existing resource ${existingId} instead of re-creating`,
        );
        await vapiFetch(`/phone-number/${existingId}`, {
          method: "PATCH",
          body: JSON.stringify({ assistantId: input.assistantId }),
        });
        return { phoneNumberId: existingId };
      }
    }
    throw err;
  }
}

/** Id of the Vapi number resource matching `number` (E.164), or null on any error/no match. */
async function findVapiPhoneNumberIdByNumber(
  number: string,
): Promise<string | null> {
  try {
    const list = await vapiFetch<Array<{ id?: string; number?: string }>>(
      "/phone-number",
      { method: "GET" },
    );
    if (!Array.isArray(list)) return null;
    const match = list.find((p) => p?.number === number);
    return match?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Places an outbound call on the existing inbound assistant and number (no
 * second assistant). assistantOverrides swaps the opener; direction and
 * contactId go into call metadata for the end-of-call handler. Returns Vapi's
 * call id, which is also the voiceCalls doc id.
 */
export async function createOutboundCall(input: {
  assistantId: string;
  phoneNumberId: string;
  customerNumber: string;
  /** Null for a test call. */
  contactId: string | null;
  /** Set for bulk campaign calls so the outcome is written back to the recipient row. */
  campaignId?: string | null;
  firstMessage: string;
  /** End-of-call pipeline skips test calls: no Contact/Task/summary written. */
  test?: boolean;
  /** Hard cap in seconds; keeps test calls short. */
  maxDurationSeconds?: number;
}): Promise<{ callId: string; controlUrl: string | null }> {
  // Must be call-level metadata: Vapi echoes it as call.metadata on every
  // webhook, but assistantOverrides.metadata isn't surfaced there.
  const metadata: Record<string, string> = { direction: "outbound" };
  if (input.contactId) metadata.contactId = input.contactId;
  if (input.campaignId) metadata.campaignId = input.campaignId;
  if (input.test) metadata.test = "1";

  const assistantOverrides: Record<string, unknown> = {
    firstMessage: input.firstMessage,
  };
  if (
    typeof input.maxDurationSeconds === "number" &&
    input.maxDurationSeconds > 0
  ) {
    assistantOverrides.maxDurationSeconds = Math.floor(
      input.maxDurationSeconds,
    );
  }

  const created = await vapiFetch<{
    id: string;
    monitor?: { controlUrl?: string };
  }>("/call", {
    method: "POST",
    body: JSON.stringify({
      assistantId: input.assistantId,
      phoneNumberId: input.phoneNumberId,
      customer: { number: input.customerNumber },
      metadata,
      assistantOverrides,
    }),
  });
  return {
    callId: created.id,
    controlUrl: created.monitor?.controlUrl ?? null,
  };
}

/**
 * Ends a live call via monitor.controlUrl (token is embedded, no auth header).
 * Best-effort; maxDurationSeconds is the backstop.
 */
export async function endCallViaControl(controlUrl: string): Promise<void> {
  const res = await fetch(controlUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "end-call" }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new VapiError(
      `Vapi control end-call -> ${res.status}`,
      res.status,
      body.slice(0, 500),
    );
  }
}

/**
 * vapi-managed mode: bind our assistant to a number the operator already owns
 * in Vapi. Never creates. No-op if already bound. A 404 means a bad pasted id
 * and is surfaced, not recovered from.
 */
export async function bindVapiAssistantToPhoneNumber(input: {
  phoneNumberId: string;
  assistantId: string;
}): Promise<{ phoneNumberId: string }> {
  await vapiFetch(`/phone-number/${input.phoneNumberId}`, {
    method: "PATCH",
    body: JSON.stringify({ assistantId: input.assistantId }),
  });
  return { phoneNumberId: input.phoneNumberId };
}

/**
 * Clears the assistant on an operator-owned number (vapi-managed disable). We
 * can't delete their number but calls shouldn't keep hitting our endpoint.
 * Best-effort.
 */
export async function unbindVapiPhoneNumber(
  phoneNumberId: string | null,
): Promise<void> {
  if (!phoneNumberId) return;
  try {
    await vapiFetch(`/phone-number/${phoneNumberId}`, {
      method: "PATCH",
      body: JSON.stringify({ assistantId: null }),
    });
  } catch (err) {
    console.warn(`[vapi] unbind phone-number ${phoneNumberId} failed`, err);
  }
}

/** Best-effort; errors swallowed so a stale resource can't block disabling the channel. */
export async function deleteVapiAssistant(
  assistantId: string | null,
): Promise<void> {
  if (!assistantId) return;
  try {
    await vapiFetch(`/assistant/${assistantId}`, { method: "DELETE" });
  } catch (err) {
    console.warn(`[vapi] delete assistant ${assistantId} failed`, err);
  }
}

export async function deleteVapiPhoneNumber(
  phoneNumberId: string | null,
): Promise<void> {
  if (!phoneNumberId) return;
  try {
    await vapiFetch(`/phone-number/${phoneNumberId}`, { method: "DELETE" });
  } catch (err) {
    console.warn(`[vapi] delete phone-number ${phoneNumberId} failed`, err);
  }
}
