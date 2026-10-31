import "server-only";

import { recordAiCost } from "@/lib/server/usage-meter";
import { runAfterResponse } from "@/lib/server/after-response";
import type { AiMeter } from "@/types/usage";

/**
 * Minimal OpenRouter client. The endpoint is OpenAI-compatible, so plain fetch,
 * no SDK. One key (OPENROUTER_API_KEY) covers every model; `model` picks it.
 * Haiku-class models cost around a cent per SMS exchange; Opus is ~50x that.
 */

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "anthropic/claude-haiku-4-5";

export interface AiChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AiCompletionResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  model: string;
  /** Actual charge in USD from OpenRouter's usage accounting; 0 when absent. */
  costUsd: number;
}

export function aiIsConfigured(): boolean {
  return !!process.env.OPENROUTER_API_KEY;
}

export function defaultAiModel(): string {
  return process.env.AI_REPLIES_DEFAULT_MODEL?.trim() || DEFAULT_MODEL;
}

interface OpenRouterChoice {
  message?: { content?: string };
}

interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** USD; OpenRouter includes it on every response. */
  cost?: number;
}

interface OpenRouterResponse {
  choices?: OpenRouterChoice[];
  usage?: OpenRouterUsage;
  model?: string;
  error?: { message?: string };
}

/** Throws on non-2xx. Callers usually log and skip the reply rather than break the webhook. */
export async function callAi({
  model,
  messages,
  maxTokens = 400,
  temperature = 0.5,
  timeoutMs = 30_000,
  meter,
}: {
  model?: string;
  messages: AiChatMessage[];
  /** 400 is roughly 300 words, a few SMS segments. */
  maxTokens?: number;
  temperature?: number;
  /**
   * Wall-clock cap. Node's fetch has no default timeout, so a stalled upstream
   * would hang until the platform kills the function (a 504 the caller can't
   * catch). Aborting turns it into a normal throw. Keep under the routes' maxDuration.
   */
  timeoutMs?: number;
  /** Who the cost belongs to. Required so no call goes unattributed. */
  meter: AiMeter;
}): Promise<AiCompletionResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY is not set — AI replies require it. Get a key at openrouter.ai.",
    );
  }

  const chosenModel = model?.trim() || defaultAiModel();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        // Optional; helps OpenRouter attribute usage.
        "HTTP-Referer":
          process.env.NEXT_PUBLIC_APP_URL ?? "https://leadstack.dev",
        "X-Title": "LeadStack AI Replies",
      },
      body: JSON.stringify({
        model: chosenModel,
        messages,
        max_tokens: maxTokens,
        temperature,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(
        `OpenRouter request timed out after ${timeoutMs}ms (model ${chosenModel})`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `OpenRouter ${res.status}: ${body.slice(0, 300) || res.statusText}`,
    );
  }

  const data = (await res.json()) as OpenRouterResponse;
  if (data.error?.message) {
    throw new Error(`OpenRouter: ${data.error.message}`);
  }

  // Billed even when the reply comes back empty, so meter before that throw.
  const usage = data.usage ?? {};
  const costUsd =
    typeof usage.cost === "number" && usage.cost > 0 ? usage.cost : 0;
  if (costUsd > 0) runAfterResponse(() => recordAiCost(meter, costUsd));

  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) {
    throw new Error("OpenRouter returned no message content");
  }

  return {
    text,
    promptTokens: usage.prompt_tokens ?? 0,
    completionTokens: usage.completion_tokens ?? 0,
    totalTokens: usage.total_tokens ?? 0,
    model: data.model ?? chosenModel,
    costUsd,
  };
}
