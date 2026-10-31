import "server-only";

import { qstashIsConfigured } from "@/lib/automations/qstash";
import { aiIsConfigured, callAi } from "@/lib/comms/ai/openrouter";
import { aiChannelGateOn } from "@/lib/comms/ai/gates";
import { resolveAgent } from "@/lib/comms/ai/agent";
import { buildSystemPrompt } from "@/lib/comms/ai/prompt";
import { buildContactContextBlock } from "@/lib/comms/ai/context";
import { subAccountTwilioIsConfigured } from "@/lib/comms/twilio";
import { segmentInfo } from "@/lib/comms/sms-segments";
import type { ResolvedAiAgent } from "@/types/ai";
import type { Contact } from "@/types/contacts";
import type { SubAccountDoc } from "@/types";

/**
 * AI-written first texts (workflow step "Send AI text"). The AI opens the
 * conversation and the existing SMS agent carries it on when the contact
 * replies, so the prerequisites are everything that reply path needs.
 */

export function aiOutboundSmsGateOn(
  sub: Pick<SubAccountDoc, "aiOutboundSmsEnabledByAgency"> | null | undefined,
): boolean {
  return sub?.aiOutboundSmsEnabledByAgency === true;
}

export interface AiOutboundSmsCheck {
  key:
    | "openrouter"
    | "qstash"
    | "twilio"
    | "sms_agent_gate"
    | "sms_agent_on"
    | "persona";
  label: string;
  ok: boolean;
  /** Where to fix it, shown when not ok. */
  fix: string;
}

export interface AiOutboundSmsReadiness {
  ready: boolean;
  checks: AiOutboundSmsCheck[];
  /** The SMS agent, reused by the step so it isn't resolved twice. */
  agent: ResolvedAiAgent | null;
}

/**
 * Everything the feature needs, gate aside. The agency gate can only be
 * switched on while this passes, and the workflow step re-checks it on every
 * send in case something was turned off later.
 */
export async function aiOutboundSmsReadiness(
  subAccountId: string,
  sub: SubAccountDoc,
): Promise<AiOutboundSmsReadiness> {
  const agent = await resolveAgent(subAccountId, "sms").catch(() => null);
  const checks: AiOutboundSmsCheck[] = [
    {
      key: "openrouter",
      label: "AI is configured on this deployment",
      ok: aiIsConfigured(),
      fix: "Set OPENROUTER_API_KEY on the deployment and redeploy.",
    },
    {
      key: "qstash",
      label: "Workflows can run (QStash)",
      ok: qstashIsConfigured(),
      fix: "Set the QSTASH_* keys on the deployment and redeploy.",
    },
    {
      key: "twilio",
      label: "The workspace has its own Twilio number",
      ok: subAccountTwilioIsConfigured(sub.twilioConfig),
      fix: "Settings → Messaging → SMS: add a dedicated Twilio number. Replies on the shared sender can't reach the AI.",
    },
    {
      key: "sms_agent_gate",
      label: "SMS AI auto-reply is allowed",
      ok: aiChannelGateOn(sub, "sms"),
      fix: "Agency → Sub-accounts → Manage: allow SMS AI auto-reply.",
    },
    {
      key: "sms_agent_on",
      label: "The SMS AI agent is switched on",
      ok: agent?.effective.enabled === true,
      fix: "AI Agents → SMS: turn the channel on, so replies get answered.",
    },
    {
      key: "persona",
      label: "The AI agent has a persona",
      ok: !!agent?.effective.systemPrompt.trim(),
      fix: "AI Agents → Overview: write the persona prompt and save.",
    },
  ];
  return { ready: checks.every((c) => c.ok), checks, agent };
}

/** First failing check, for logs and error messages. */
export function firstUnmet(r: AiOutboundSmsReadiness): AiOutboundSmsCheck | null {
  return r.checks.find((c) => !c.ok) ?? null;
}

/** Two SMS segments at most, opt-out line included, so cost stays predictable. */
const AI_OPENER_MAX_SEGMENTS = 2;
/** Prompt guidance; fitSegments enforces the real limit. */
const AI_OPENER_TARGET_CHARS = 260;
const OPT_OUT_SUFFIX = " Reply STOP to opt out.";

function openerBlock(instruction: string, maxChars: number): string {
  return `--- FIRST MESSAGE ---
You are starting this text conversation. The contact has NOT messaged you; never imply they did or that you are replying.
Goal from the business: ${instruction}
Write exactly one text message, at most ${maxChars} characters, plain text with straight quotes, no markdown, no emoji, no [[markers]]. Say which business you are in the first sentence, use what you know about the contact only where it's accurate, and end with one short question that invites a reply. Don't invent prices, offers, dates or appointment times.
--- END FIRST MESSAGE ---`;
}

/** Smart punctuation from the model would switch the text to UCS-2 (67 chars a segment). */
function toGsmFriendly(text: string): string {
  return text
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/…/g, "...")
    .replace(/ /g, " ");
}

/** Drops a trailing word or sentence until the text fits the segment budget. */
function fitSegments(text: string, maxSegments: number): string {
  let out = text;
  while (out && segmentInfo(out).segments > maxSegments) {
    const sentenceEnd = Math.max(
      out.lastIndexOf(". ", out.length - 2),
      out.lastIndexOf("? ", out.length - 2),
      out.lastIndexOf("! ", out.length - 2),
    );
    const cut =
      sentenceEnd > out.length * 0.5
        ? out.slice(0, sentenceEnd + 1)
        : out.slice(0, Math.max(0, out.lastIndexOf(" "))).trimEnd();
    out = cut === out ? out.slice(0, -1) : cut;
  }
  return out;
}

function cleanOpener(raw: string, maxSegments: number): string {
  const text = toGsmFriendly(raw)
    // Markers, including one the model never closed.
    .replace(/\[\[[\s\S]*?\]\]/g, "")
    .replace(/\[\[[\s\S]*$/, "")
    // Markdown emphasis only; underscores and # stay because links use them.
    .replace(/\*\*|`/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["']+|["']+$/g, "")
    .trim();
  return fitSegments(text, maxSegments);
}

export async function generateAiOpener(input: {
  subAccountId: string;
  agent: ResolvedAiAgent;
  sub: SubAccountDoc;
  contact: Contact;
  instruction: string;
  appendOptOut: boolean;
}): Promise<{ text: string; tokens: number; model: string }> {
  const maxChars = input.appendOptOut
    ? AI_OPENER_TARGET_CHARS - OPT_OUT_SUFFIX.length
    : AI_OPENER_TARGET_CHARS;
  const contextBlock = await buildContactContextBlock(input.contact).catch(
    () => null,
  );
  const system = [
    buildSystemPrompt({
      agent: input.agent,
      channelId: "sms",
      fallbackBusinessName: input.sub.name ?? "the business",
      contactContextBlock: contextBlock,
      bookingLink: input.sub.bookingLink ?? null,
    }),
    openerBlock(input.instruction, maxChars),
  ].join("\n\n");
  const completion = await callAi({
    model: input.agent.effective.modelOverride ?? undefined,
    messages: [
      { role: "system", content: system },
      { role: "user", content: "Write the first text message now." },
    ],
    maxTokens: 200,
    temperature: 0.6,
    meter: { subAccountId: input.subAccountId, source: "workflows" },
  });
  const suffix = input.appendOptOut ? OPT_OUT_SUFFIX : "";
  const body = fitSegments(
    cleanOpener(completion.text, AI_OPENER_MAX_SEGMENTS),
    AI_OPENER_MAX_SEGMENTS,
  );
  // Trim the body (never the opt-out line) until both fit together.
  let fitted = body;
  while (fitted && segmentInfo(`${fitted}${suffix}`).segments > AI_OPENER_MAX_SEGMENTS) {
    fitted = fitSegments(fitted.slice(0, -1), AI_OPENER_MAX_SEGMENTS);
  }
  if (!fitted.trim()) throw new Error("The AI returned an empty message.");
  return {
    text: `${fitted}${suffix}`,
    tokens: completion.totalTokens,
    model: completion.model,
  };
}
