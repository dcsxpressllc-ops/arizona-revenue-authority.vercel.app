import "server-only";

import { NextResponse } from "next/server";
import {
  requireAgencyOwnerAny,
  requireSubAccountMember,
} from "@/lib/auth/require-tenancy";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  aiSuiteIsConfigured,
  aiSuiteModel,
  normalizeAiSuiteModelChoice,
  runAiSuiteTurn,
  type AiSuiteLlmMessage,
} from "@/lib/ai-suite/model";
import { recordAiSuiteUsage } from "@/lib/ai-suite/usage";
import { retrieveKnowledge } from "@/lib/ai-suite/retrieve";
import { buildAiSuiteSystemPrompt } from "@/lib/ai-suite/prompt";
import {
  CapabilityUserError,
  capabilityNamesForLevel,
  getCapability,
  roleSatisfies,
  toolsForLevel,
  type AiSuiteActionContext,
} from "@/lib/ai-suite/capabilities";
import { CUSTOM_BRAND } from "@/config/landing";
import type {
  AiSuiteChatMessage,
  AiSuiteChatRequest,
  AiSuiteChatResponse,
  AiSuiteLevel,
} from "@/types/ai-suite";

import { runAfterResponse } from "@/lib/server/after-response";
export const dynamic = "force-dynamic";

const MAX_HISTORY_TURNS = 12;
const MAX_MESSAGE_CHARS = 4000;
/** Max read-only lookups the model may chain in one user turn. */
const MAX_LOOKUP_HOPS = 3;
/**
 * Max rounds where an invalid write proposal's validation error goes back to
 * the model to fix itself, instead of bouncing it to the user.
 */
const MAX_VALIDATION_RETRIES = 2;

function sanitizeMessages(input: unknown): AiSuiteChatMessage[] | null {
  if (!Array.isArray(input)) return null;
  const cleaned: AiSuiteChatMessage[] = [];
  for (const m of input) {
    if (!m || typeof m !== "object") continue;
    const role = (m as { role?: unknown }).role;
    const content = (m as { content?: unknown }).content;
    if (role !== "user" && role !== "assistant") continue;
    if (typeof content !== "string") continue;
    const trimmed = content.trim();
    if (!trimmed) continue;
    cleaned.push({ role, content: trimmed.slice(0, MAX_MESSAGE_CHARS) });
  }
  return cleaned.slice(-MAX_HISTORY_TURNS);
}

type RoleCtx = { agencyRoleIsOwner: boolean; subAccountRole?: string };

export async function POST(request: Request) {
  let body: AiSuiteChatRequest;
  try {
    body = (await request.json()) as AiSuiteChatRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const level = body.level;
  if (level !== "agency" && level !== "sub-account") {
    return NextResponse.json(
      { error: "`level` must be 'agency' or 'sub-account'." },
      { status: 400 },
    );
  }

  // Auth and the agency gate. The route decides who can act, never the model.
  let roleCtx: RoleCtx;
  let actionCtx: AiSuiteActionContext;
  let usageAgencyId = "";
  let workspaceName = "";
  // OpenRouter slug, from the owner-picked tier on the doc loaded for the gate.
  let turnModel = aiSuiteModel();
  if (level === "sub-account") {
    if (!body.subAccountId || typeof body.subAccountId !== "string") {
      return NextResponse.json(
        { error: "`subAccountId` is required for sub-account level." },
        { status: 400 },
      );
    }
    const access = await requireSubAccountMember(request, body.subAccountId);
    if (access instanceof NextResponse) return access;

    const subSnap = await getAdminDb()
      .doc(`subAccounts/${body.subAccountId}`)
      .get();
    // Opt-in: off unless the agency owner enabled it (unset reads as off).
    if (subSnap.data()?.aiSuiteEnabledByAgency !== true) {
      return NextResponse.json(
        {
          error:
            "The AI Suite is disabled for this sub-account. Ask your agency owner to enable it.",
        },
        { status: 403 },
      );
    }
    workspaceName =
      typeof subSnap.data()?.name === "string" ? subSnap.data()!.name : "";
    turnModel = aiSuiteModel(
      normalizeAiSuiteModelChoice(subSnap.data()?.aiSuiteModel),
    );
    roleCtx = {
      agencyRoleIsOwner: access.subAccountRole === "agencyOwner",
      subAccountRole: access.subAccountRole,
    };
    actionCtx = {
      uid: access.uid,
      email: access.email,
      displayName: "",
      agencyId: access.agencyId ?? "",
      subAccountId: body.subAccountId,
      subAccountRole: access.subAccountRole,
    };
    usageAgencyId = access.agencyId ?? "";
  } else {
    const owner = await requireAgencyOwnerAny(request);
    if (owner instanceof NextResponse) return owner;
    // Off unless enabled under Agency -> Settings (unset reads as off).
    const agencySnap = await getAdminDb()
      .doc(`agencies/${owner.agencyId}`)
      .get();
    if (agencySnap.data()?.agencyAssistantEnabled !== true) {
      return NextResponse.json(
        {
          error:
            "The Agency Assistant is turned off. Enable it under Agency → Settings.",
        },
        { status: 403 },
      );
    }
    turnModel = aiSuiteModel(
      normalizeAiSuiteModelChoice(agencySnap.data()?.agencyAssistantModel),
    );
    roleCtx = { agencyRoleIsOwner: true };
    actionCtx = {
      uid: owner.uid,
      email: owner.email,
      displayName: "",
      agencyId: owner.agencyId ?? "",
    };
    usageAgencyId = owner.agencyId ?? "";
  }

  if (!aiSuiteIsConfigured()) {
    return NextResponse.json(
      {
        error:
          "The AI Suite isn't configured on this deployment. Set OPENROUTER_API_KEY to enable it.",
      },
      { status: 503 },
    );
  }

  const messages = sanitizeMessages(body.messages);
  if (!messages || messages.length === 0) {
    return NextResponse.json(
      { error: "At least one message is required." },
      { status: 400 },
    );
  }
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) {
    return NextResponse.json(
      { error: "The latest turn must include a user message." },
      { status: 400 },
    );
  }

  const lvl = level as AiSuiteLevel;
  const tools = toolsForLevel(lvl, roleCtx);
  const { actions: actionNames, lookups: lookupNames } =
    capabilityNamesForLevel(lvl, roleCtx);

  // Retrieve over recent turns so "how do I turn that on?" still finds the
  // feature named earlier. The latest question is doubled to dominate scoring.
  const recentUsers = messages.filter((m) => m.role === "user").slice(-2);
  const lastAssistant = [...messages]
    .reverse()
    .find((m) => m.role === "assistant");
  const retrievalQuery = [
    ...recentUsers.map((m) => m.content),
    lastAssistant?.content ?? "",
    lastUser.content,
  ]
    .filter(Boolean)
    .join("\n");
  const cards = retrieveKnowledge(retrievalQuery, lvl);

  const systemPrompt = buildAiSuiteSystemPrompt({
    level: lvl,
    brandName: CUSTOM_BRAND.name || "your CRM",
    cards,
    actionNames,
    lookupNames,
    todayIso: new Date().toISOString().slice(0, 10),
    caller: {
      email: actionCtx.email,
      isAgencyOwner: roleCtx.agencyRoleIsOwner,
      ...(lvl === "sub-account"
        ? { workspaceName, workspaceRole: actionCtx.subAccountRole }
        : {}),
    },
    deployment: {
      // Push needs both VAPID keys (client subscribes, server sends).
      pushNotificationsConfigured: Boolean(
        process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim() &&
          process.env.VAPID_PRIVATE_KEY?.trim(),
      ),
    },
  });

  const llmMessages: AiSuiteLlmMessage[] = [
    // Stable half carries the prompt-cache breakpoint; per-turn cards + date
    // go after it so retrieval changes don't bust the cached prefix.
    {
      role: "system",
      content: systemPrompt.stable,
      dynamicTail: systemPrompt.dynamic,
    },
    ...messages,
  ];

  // Run read-only lookups inline until the model returns text or a write
  // proposal. Writes never execute here; invalid write args go back to the
  // model as a tool result so it can self-correct.
  let turn;
  try {
    let lookupHops = 0;
    let fixAttempts = 0;
    for (;;) {
      turn = await runAiSuiteTurn({
        messages: llmMessages,
        tools,
        model: turnModel,
        // The Agency Assistant is the agency's own tool, even when it acts in a client workspace.
        meter:
          level === "sub-account" && body.subAccountId
            ? { subAccountId: body.subAccountId, source: "assistant" }
            : { agencyInternal: true },
      });
      const call = turn.toolCall;
      if (!call) break;
      const cap = getCapability(call.name);
      if (!cap || cap.level !== lvl) break;

      // Write: validate only. Valid falls through to the proposal path,
      // invalid bounces back to the model (capped).
      if (!cap.readonly) {
        const check = cap.validate(call.args);
        if (check.ok || fixAttempts >= MAX_VALIDATION_RETRIES) break;
        fixAttempts++;
        llmMessages.push(
          {
            role: "assistant",
            content: turn.text,
            tool_calls: [
              {
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: JSON.stringify(call.args) },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: call.id,
            content: `Invalid arguments — nothing was proposed to the user: ${check.error}. Fix the arguments and call the tool again. Only ask the user when the fix needs information you don't have.`,
          },
        );
        continue;
      }

      if (
        lookupHops >= MAX_LOOKUP_HOPS ||
        !roleSatisfies(cap.requiredRole, roleCtx)
      ) {
        break; // over budget or not allowed: treated as text
      }
      lookupHops++;
      const validated = cap.validate(call.args);
      let lookupResult: string;
      if (!validated.ok) {
        lookupResult = `Invalid arguments: ${validated.error}.`;
      } else {
        try {
          const execResult = await cap.execute(actionCtx, validated.args);
          // A navigation target short-circuits: message + button, no final turn.
          if (execResult.navigate) {
            runAfterResponse(() => recordAiSuiteUsage({
              level: lvl,
              agencyId: usageAgencyId,
              subAccountId:
                level === "sub-account" ? body.subAccountId : undefined,
              kind: "message",
            }));
            const response: AiSuiteChatResponse = {
              type: "navigate",
              text: execResult.resultText,
              href: execResult.navigate.href,
              label: execResult.navigate.label,
            };
            return NextResponse.json(response);
          }
          lookupResult = execResult.resultText;
        } catch (err) {
          console.error(
            `[ai-suite/chat] lookup ${cap.name} failed:`,
            err instanceof Error ? err.message : err,
          );
          lookupResult =
            err instanceof CapabilityUserError
              ? `The lookup couldn't run: ${err.message}`
              : "The lookup failed. Answer without it, and say the data couldn't be checked.";
        }
      }
      llmMessages.push(
        {
          role: "assistant",
          content: turn.text,
          tool_calls: [
            {
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            },
          ],
        },
        { role: "tool", tool_call_id: call.id, content: lookupResult },
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error("[ai-suite/chat] model call failed:", msg);
    return NextResponse.json(
      { error: "The assistant couldn't reach the model. Please try again." },
      { status: 502 },
    );
  }

  // Count this turn toward daily usage (best-effort; never blocks the reply).
  runAfterResponse(() => recordAiSuiteUsage({
    level: lvl,
    agencyId: usageAgencyId,
    subAccountId: level === "sub-account" ? body.subAccountId : undefined,
    kind: "message",
  }));

  // Surface a write as a proposal; nothing executes here. A readonly call
  // landing here means the lookup cap was hit, so treat it as text.
  if (turn.toolCall) {
    const cap = getCapability(turn.toolCall.name);
    if (cap && !cap.readonly && cap.level === lvl) {
      const validated = cap.validate(turn.toolCall.args);
      if (validated.ok) {
        const response: AiSuiteChatResponse = {
          type: "proposal",
          proposal: {
            id: turn.toolCall.id,
            capability: cap.name,
            // Raw model args, not validated.args: the confirm route re-runs
            // validate(), and a validate() that transforms keys (e.g.
            // create_website, snake_case in, camelCase out) would reject its
            // own output.
            args: turn.toolCall.args,
            summary: cap.summarize(validated.args),
          },
        };
        return NextResponse.json(response);
      }
      // Still invalid after the self-correction rounds: ask, don't propose.
      const response: AiSuiteChatResponse = {
        type: "message",
        text: `I can help with that, but ${validated.error}. Could you tell me?`,
      };
      return NextResponse.json(response);
    }
  }

  const response: AiSuiteChatResponse = {
    type: "message",
    text:
      turn.text ||
      "I'm not sure how to help with that — could you rephrase, or ask how a feature works?",
  };
  return NextResponse.json(response);
}
