import "server-only";

/**
 * OpenRouter client for the AI Suite. One non-streaming, tool-enabled call per
 * turn: the model either answers in text or requests one tool. Lookup tools run
 * in the chat route and feed a follow-up turn; write tools are surfaced as a
 * proposal for the user to confirm, never executed here.
 *
 * Uses OPENROUTER_API_KEY, the same key as the AI Agents client.
 */

import type { AiSuiteModelChoice } from "@/types/tenancy";
import type { AiMeter } from "@/types/usage";
import { recordAiCost } from "@/lib/server/usage-meter";
import { runAfterResponse } from "@/lib/server/after-response";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// Friendly "opus"/"sonnet" keys stored on tenant docs map to OpenRouter slugs
// here and only here. Set AI_SUITE_MODEL to override if a slug changes.
const AI_SUITE_MODEL_SLUGS: Record<AiSuiteModelChoice, string> = {
  opus: "anthropic/claude-opus-4-8",
  sonnet: "anthropic/claude-sonnet-4-6",
};

// Opus keeps existing deployments on the model they had; prompt caching keeps
// it affordable. Owners can drop a tenant to Sonnet for cost.
export const DEFAULT_AI_SUITE_MODEL_CHOICE: AiSuiteModelChoice = "opus";

/** Anything invalid falls back to the default. */
export function normalizeAiSuiteModelChoice(v: unknown): AiSuiteModelChoice {
  return v === "sonnet" ? "sonnet" : DEFAULT_AI_SUITE_MODEL_CHOICE;
}

export function aiSuiteIsConfigured(): boolean {
  return !!process.env.OPENROUTER_API_KEY;
}

/** Precedence: AI_SUITE_MODEL env (wins over every tenant pick), then the tenant choice, then the default. */
export function aiSuiteModel(choice?: AiSuiteModelChoice): string {
  const override = process.env.AI_SUITE_MODEL?.trim();
  if (override) return override;
  return AI_SUITE_MODEL_SLUGS[choice ?? DEFAULT_AI_SUITE_MODEL_CHOICE];
}

export interface AiSuiteToolDef {
  type: "function";
  function: Record<string, unknown>;
}

export interface AiSuiteRawToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/**
 * Superset of plain system/user/assistant turns: after a lookup the chat route
 * appends an assistant turn with `tool_calls` plus the matching `tool` result.
 */
export type AiSuiteLlmMessage =
  | {
      role: "system";
      /** Conversation-stable half; carries the cache breakpoint. */
      content: string;
      /** Per-turn half (knowledge cards, date), sent after the breakpoint so it doesn't bust the cache. */
      dynamicTail?: string;
    }
  | { role: "user" | "assistant"; content: string }
  | { role: "assistant"; content: string | null; tool_calls: AiSuiteRawToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface AiSuiteTurnResult {
  text: string | null;
  /** First tool call only. */
  toolCall: { id: string; name: string; args: Record<string, unknown> } | null;
}

interface OpenRouterToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenRouterChatResponse {
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: OpenRouterToolCall[] };
  }>;
  usage?: { cost?: number };
  error?: { message?: string };
}

export async function runAiSuiteTurn({
  messages,
  tools,
  maxTokens = 1024,
  model,
  meter,
}: {
  messages: AiSuiteLlmMessage[];
  tools: AiSuiteToolDef[];
  maxTokens?: number;
  /** Defaults to `aiSuiteModel()`. */
  model?: string;
  /** Who the cost belongs to. Required so no call goes unattributed. */
  meter: AiMeter;
}): Promise<AiSuiteTurnResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY is not set — the AI Suite requires it. Get a key at openrouter.ai.",
    );
  }

  // Prompt caching (Anthropic via OpenRouter). The system prompt + tool defs are
  // ~20k tokens and identical across every call in a conversation, so the
  // cache_control breakpoint goes on the stable block and dynamicTail follows it.
  // A changed retrieval only re-bills its own 1-2k tokens. Tools serialize before
  // system in Anthropic's cache order, so one breakpoint covers both. Providers
  // without caching ignore the field.
  const wireMessages = messages.map((m) =>
    m.role === "system"
      ? {
          role: "system" as const,
          content: [
            {
              type: "text" as const,
              text: m.content,
              cache_control: { type: "ephemeral" as const },
            },
            ...(m.dynamicTail
              ? [{ type: "text" as const, text: m.dynamicTail }]
              : []),
          ],
        }
      : m,
  );

  const body: Record<string, unknown> = {
    model: model ?? aiSuiteModel(),
    messages: wireMessages,
    max_tokens: maxTokens,
    temperature: 0.3,
  };
  // Some providers reject an empty tools array.
  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer":
        process.env.NEXT_PUBLIC_APP_URL ?? "https://leadstack.dev",
      "X-Title": "LeadStack AI Suite",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `OpenRouter ${res.status}: ${text.slice(0, 300) || res.statusText}`,
    );
  }

  const data = (await res.json()) as OpenRouterChatResponse;
  const costUsd = data.usage?.cost;
  if (typeof costUsd === "number" && costUsd > 0) {
    runAfterResponse(() => recordAiCost(meter, costUsd));
  }
  if (data.error?.message) {
    throw new Error(`OpenRouter: ${data.error.message}`);
  }

  const message = data.choices?.[0]?.message;
  const text = message?.content?.trim() || null;

  const rawCall = message?.tool_calls?.[0];
  let toolCall: AiSuiteTurnResult["toolCall"] = null;
  if (rawCall?.function?.name) {
    let args: Record<string, unknown> = {};
    try {
      args = rawCall.function.arguments
        ? (JSON.parse(rawCall.function.arguments) as Record<string, unknown>)
        : {};
    } catch {
      args = {};
    }
    toolCall = {
      id: rawCall.id || `call_${rawCall.function.name}`,
      name: rawCall.function.name,
      args,
    };
  }

  return { text, toolCall };
}
