import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  sendSmsForSubAccount,
  sendWhatsappForSubAccount,
} from "@/lib/comms/twilio";
import { sendMetaMessage } from "@/lib/comms/meta";
import { smsSendBlock } from "@/lib/comms/sms-consent";
import { isWithinBusinessHours } from "@/lib/comms/business-hours";
import { checkQuotas } from "@/lib/server/usage-meter";
import { callAi, type AiChatMessage } from "@/lib/comms/ai/openrouter";
import {
  incrementChannelTokens,
  type ConfiguredChannelId,
} from "@/lib/comms/ai/agent";
import { buildContactContextBlock } from "@/lib/comms/ai/context";
import { buildSystemPrompt } from "@/lib/comms/ai/prompt";
import {
  callAiWithMessagingBooking,
  prepareMessagingBooking,
} from "@/lib/comms/ai/messaging-booking";
import {
  matchEscalationKeyword,
  sendEscalationNotification,
} from "@/lib/comms/ai/escalation";
import type { ResolvedAiAgent } from "@/types/ai";
import type { SubAccountDoc } from "@/types";
import type { Contact } from "@/types/contacts";
import {
  getConversationControls,
  setConversationDraft,
  upsertConversationForMessage,
} from "@/lib/server/conversations-service";
import type { ConversationChannel } from "@/types/conversations";
import { runAfterResponse } from "@/lib/server/after-response";

interface RespondInput {
  subAccountId: string;
  subAccount: SubAccountDoc;
  /** Already merged by resolveAgent(). */
  agent: ResolvedAiAgent;
  /**
   * sms, whatsapp (Twilio), meta (Messenger/Instagram) or email (draft-only;
   * suggestOnly is forced so the send never runs). Same pipeline for all, only
   * the transport differs. Web chat and voice have their own orchestrators.
   */
  channelId: ConfiguredChannelId;
  contact: Contact;
  incomingMessage: string;
  /** Caller's phone (Twilio) or the sender's Meta-scoped id. */
  replyTo: string;
  /** Required for meta: the platform the DM came in on. The reply and conversation channel follow it. */
  metaChannel?: "messenger" | "instagram";
}

type AiSkipReason =
  | "disabled"
  | "no_prompt"
  | "outside_hours"
  | "escalation_keyword"
  | "contact_opted_out"
  | "bot_off"
  | "bot_paused"
  | "quota"
  | "llm_failed";

type RespondOutcome =
  | { kind: "replied"; replyText: string; tokens: number }
  | { kind: "escalated"; keyword: string }
  | { kind: "drafted"; replyText: string; tokens: number }
  | { kind: "skipped"; reason: AiSkipReason };

/**
 * What differs per channel: thread subcollection, opt-out flag, provider send,
 * outbound row fields and activity label. Everything else is one orchestrator.
 */
interface ChannelTransport {
  /** Subcollection under contacts/{id}. */
  messagesCollection: string;
  /** metaMessages holds both messenger and instagram rows, so filter history by `channel`. */
  historyChannelFilter?: string;
  /** For activity-log lines ("SMS", "Instagram", ...). */
  label: string;
  isOptedOut: (contact: Contact) => boolean;
  /** Returns the provider message id and from address. */
  send: (args: {
    subAccountId: string;
    subAccount: SubAccountDoc;
    to: string;
    body: string;
  }) => Promise<{ sid: string; from: string }>;
  /** Provider-specific thread-row fields (id field name, channel discriminator). */
  outboundRowExtras: (sid: string) => Record<string, unknown>;
}

function getChannelTransport(
  channelId: ConfiguredChannelId,
  metaChannel?: "messenger" | "instagram",
): ChannelTransport {
  if (channelId === "whatsapp") {
    // No 24h session-window check needed: this only runs right after an inbound
    // WhatsApp message, so the window is open. Manual sends enforce it in
    // /api/comms/whatsapp/send.
    return {
      messagesCollection: "whatsappMessages",
      label: "WhatsApp",
      isOptedOut: (c) => c.whatsappOptedOut === true,
      send: ({ subAccountId, subAccount, to, body }) =>
        sendWhatsappForSubAccount({ subAccountId, subAccount, to, body }),
      outboundRowExtras: (sid) => ({ twilioMessageSid: sid }),
    };
  }
  if (channelId === "sms") {
    return {
      messagesCollection: "messages",
      label: "SMS",
      isOptedOut: (c) => smsSendBlock(c) !== null,
      send: ({ subAccountId, subAccount, to, body }) =>
        sendSmsForSubAccount({ subAccountId, subAccount, to, body }).then(
          (r) => ({ sid: r.sid, from: r.from }),
        ),
      outboundRowExtras: (sid) => ({ twilioMessageSid: sid }),
    };
  }
  if (channelId === "meta") {
    // Messenger/Instagram over the Graph API; the inbound webhook always passes the
    // platform the DM came in on. No 24h window check (we're replying to a fresh
    // inbound) and no opt-out flag: Meta has no STOP, users block the Page and
    // Meta rejects the send.
    const platform = metaChannel ?? "messenger";
    return {
      messagesCollection: "metaMessages",
      historyChannelFilter: platform,
      label: platform === "instagram" ? "Instagram" : "Messenger",
      isOptedOut: () => false,
      send: async ({ subAccount, to, body }) => {
        const cfg = subAccount.metaConfig;
        if (!cfg?.connected || !cfg.pageAccessToken || !cfg.pageId) {
          throw new Error("No connected Meta Page for this sub-account.");
        }
        const messageId = await sendMetaMessage({
          channel: platform,
          fromNodeId: cfg.pageId,
          recipientId: to,
          text: body,
          pageAccessToken: cfg.pageAccessToken,
        });
        return { sid: messageId, from: cfg.pageId };
      },
      outboundRowExtras: (sid) => ({ channel: platform, metaMessageId: sid }),
    };
  }
  if (channelId === "email") {
    // Suggest-only: the orchestrator forces suggestOnly, so `send` can't be reached.
    // Approval goes through /api/comms/email/send like a manual reply.
    return {
      messagesCollection: "emailMessages",
      label: "Email",
      isOptedOut: (c) => c.emailOptedOut === true,
      send: async () => {
        throw new Error(
          "Email AI is draft-only — approved drafts send via /api/comms/email/send.",
        );
      },
      outboundRowExtras: () => ({}),
    };
  }
  // Web chat and voice have their own orchestrators.
  throw new Error(
    `maybeRespondWithAi does not support channel "${channelId}".`,
  );
}

// Supports overnight windows (e.g. 22 to 6). Shared with web chat via lib/comms/business-hours.ts.
const isWithinHours = isWithinBusinessHours;

async function loadRecentHistory(
  contactId: string,
  limit: number,
  excludeBody: string,
  messagesCollection: string,
  channelFilter?: string,
): Promise<AiChatMessage[]> {
  const safeLimit = Math.max(1, Math.min(50, limit));
  // With a channel filter, over-fetch so in-code filtering still gives ~limit
  // turns. Cheaper than a where() that would need a composite index.
  const fetchLimit = channelFilter
    ? Math.min(50, safeLimit * 2 + 1)
    : safeLimit + 1;
  const snap = await getAdminDb()
    .collection("contacts")
    .doc(contactId)
    .collection(messagesCollection)
    .orderBy("createdAt", "desc")
    .limit(fetchLimit)
    .get();
  const docs = snap.docs.reverse();
  const turns: AiChatMessage[] = [];
  for (const d of docs) {
    const data = d.data() as {
      direction?: string;
      body?: string;
      channel?: string;
    };
    if (!data.body) continue;
    if (channelFilter && data.channel !== channelFilter) continue;
    if (data.direction === "inbound" && data.body.trim() === excludeBody.trim()) {
      continue;
    }
    turns.push({
      role: data.direction === "outbound" ? "assistant" : "user",
      content: data.body,
    });
  }
  return turns;
}


async function logActivity({
  contactId,
  agencyId,
  subAccountId,
  type,
  content,
  meta,
}: {
  contactId: string;
  agencyId: string;
  subAccountId: string;
  type: "ai_reply_sent" | "ai_escalated" | "ai_skipped";
  content: string;
  meta?: Record<string, unknown>;
}): Promise<void> {
  try {
    await getAdminDb()
      .collection("contacts")
      .doc(contactId)
      .collection("activities")
      .add({
        type,
        content,
        meta: meta ?? null,
        agencyId,
        subAccountId,
        createdBy: "ai_inbound",
        createdAt: FieldValue.serverTimestamp(),
      });
  } catch (err) {
    console.warn("[ai/respond] activity write failed", err);
  }
}

async function storeOutboundReply({
  contactId,
  agencyId,
  subAccountId,
  body,
  from,
  to,
  providerSid,
  messagesCollection,
  extras,
}: {
  contactId: string;
  agencyId: string;
  subAccountId: string;
  body: string;
  from: string;
  to: string;
  /** Also the doc id, so retries dedupe naturally. */
  providerSid: string;
  messagesCollection: string;
  /** e.g. `twilioMessageSid`, or `channel` + `metaMessageId` for Meta. */
  extras: Record<string, unknown>;
}): Promise<void> {
  try {
    await getAdminDb()
      .collection("contacts")
      .doc(contactId)
      .collection(messagesCollection)
      .doc(providerSid)
      .set(
        {
          agencyId,
          subAccountId,
          contactId,
          direction: "outbound",
          status: "sent",
          body,
          from,
          to,
          ...extras,
          sentByUid: "ai",
          aiGenerated: true,
          error: null,
          readAt: null,
          createdAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
  } catch (err) {
    console.warn("[ai/respond] outbound message write failed", err);
  }
}

/** Guards, context, LLM, send, log. The caller already resolved the agent. */
export async function maybeRespondWithAi(
  input: RespondInput,
): Promise<RespondOutcome> {
  const {
    subAccountId,
    subAccount,
    agent,
    channelId,
    contact,
    incomingMessage,
    replyTo,
    metaChannel,
  } = input;
  const eff = agent.effective;
  const transport = getChannelTransport(channelId, metaChannel);
  // Meta conversations use the platform ("messenger" | "instagram"); Twilio ones use the channel id.
  const conversationChannel = (metaChannel ?? channelId) as ConversationChannel;

  if (transport.isOptedOut(contact)) {
    await logActivity({
      contactId: contact.id,
      agencyId: subAccount.agencyId,
      subAccountId,
      type: "ai_skipped",
      content: `AI reply skipped — contact is ${transport.label}-opted-out.`,
      meta: { reason: "contact_opted_out", channel: channelId },
    });
    return { kind: "skipped", reason: "contact_opted_out" };
  }

  // Blank prompt: send nothing.
  if (!eff.systemPrompt.trim()) {
    await logActivity({
      contactId: contact.id,
      agencyId: subAccount.agencyId,
      subAccountId,
      type: "ai_skipped",
      content: "AI reply skipped — agent persona prompt is empty.",
      meta: { reason: "no_prompt" },
    });
    return { kind: "skipped", reason: "no_prompt" };
  }

  if (!isWithinHours(eff.hoursStart, eff.hoursEnd, eff.timezone)) {
    await logActivity({
      contactId: contact.id,
      agencyId: subAccount.agencyId,
      subAccountId,
      type: "ai_skipped",
      content: `AI reply skipped — outside business hours (${eff.hoursStart}:00–${eff.hoursEnd}:00 ${eff.timezone}).`,
      meta: { reason: "outside_hours" },
    });
    return { kind: "skipped", reason: "outside_hours" };
  }

  // Monthly AI quotas, checked before the LLM call so an over-cap workspace
  // spends nothing. Fails open.
  const tokenQuota = await checkQuotas({
    subAccountId,
    units: ["aiTokens", "aiReplies"],
    subAccount,
  });
  if (!tokenQuota.allowed) {
    await logActivity({
      contactId: contact.id,
      agencyId: subAccount.agencyId,
      subAccountId,
      type: "ai_skipped",
      content: "AI reply skipped — monthly AI usage limit reached.",
      meta: { reason: "quota" },
    });
    return { kind: "skipped", reason: "quota" };
  }

  const triggered = matchEscalationKeyword(
    incomingMessage,
    eff.escalationKeywords,
  );
  if (triggered) {
    if (eff.escalationNotifyEmail) {
      const appUrl =
        process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://leadstack.dev";
      await sendEscalationNotification({
        to: eff.escalationNotifyEmail,
        businessName:
          eff.businessName.trim() || subAccount.name || "your business",
        contactName: contact.name || "(unnamed)",
        // Meta contacts often have no phone; the platform label beats a raw scoped id.
        contactPhone:
          contact.phone?.trim() ||
          (metaChannel ? `(via ${transport.label})` : replyTo),
        contactId: contact.id,
        subAccountId,
        triggeredKeyword: triggered,
        incomingMessage,
        appUrl,
      });
    }
    await logActivity({
      contactId: contact.id,
      agencyId: subAccount.agencyId,
      subAccountId,
      type: "ai_escalated",
      content: `AI escalated to human — keyword "${triggered}" matched in inbound message.`,
      meta: { reason: "escalation_keyword", keyword: triggered, channel: channelId },
    });
    return { kind: "escalated", keyword: triggered };
  }

  // Per-conversation controls from the inbox, on top of the channel-level
  // `enabled` check. Pause beats mode. Missing = auto, not paused.
  const controls = await getConversationControls(contact.id);
  if (controls.botPausedUntilMs && controls.botPausedUntilMs > Date.now()) {
    await logActivity({
      contactId: contact.id,
      agencyId: subAccount.agencyId,
      subAccountId,
      type: "ai_skipped",
      content: "AI reply skipped — bot paused after a human took over.",
      meta: { reason: "bot_paused", channel: channelId },
    });
    return { kind: "skipped", reason: "bot_paused" };
  }
  if (controls.botMode === "off") {
    await logActivity({
      contactId: contact.id,
      agencyId: subAccount.agencyId,
      subAccountId,
      type: "ai_skipped",
      content: "AI reply skipped — bot turned off for this conversation.",
      meta: { reason: "bot_off", channel: channelId },
    });
    return { kind: "skipped", reason: "bot_off" };
  }
  // Email never auto-sends, even in "auto" mode: replies land as a pendingDraft.
  const suggestOnly = controls.botMode === "suggest" || channelId === "email";

  let completion;
  try {
    const [history, contextBlock] = await Promise.all([
      loadRecentHistory(
        contact.id,
        eff.contextMessageCount,
        incomingMessage,
        transport.messagesCollection,
        transport.historyChannelFilter,
      ),
      buildContactContextBlock(contact).catch((err) => {
        console.warn(
          `[ai/respond] context block build failed for ${contact.id}`,
          err,
        );
        return null;
      }),
    ]);
    let systemPrompt = buildSystemPrompt({
      agent,
      channelId,
      fallbackBusinessName: subAccount.name ?? "the business",
      contactContextBlock: contextBlock,
      bookingLink: subAccount.bookingLink ?? null,
    });
    // Live booking only when the reply is sent straight away (never email,
    // which is always a draft): a draft saying "you're booked" must never
    // exist without the booking behind it.
    const booking =
      !suggestOnly
        ? await prepareMessagingBooking({ subAccountId, agent, contact }).catch(
            (err) => {
              console.warn(`[ai/respond] booking prep failed sa=${subAccountId}`, err);
              return null;
            },
          )
        : null;
    if (booking) systemPrompt += `\n\n${booking.promptBlock}`;
    const messages: AiChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user", content: incomingMessage },
    ];
    completion = booking
      ? await callAiWithMessagingBooking({
          messages,
          ai: { model: eff.modelOverride ?? undefined },
          booking,
          subAccountId,
          agencyId: subAccount.agencyId,
          contact,
        })
      : await callAi({
          model: eff.modelOverride ?? undefined,
          messages,
          meter: { subAccountId, source: "replies" },
        });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(`[ai/respond] LLM call failed for sa=${subAccountId}: ${msg}`);
    await logActivity({
      contactId: contact.id,
      agencyId: subAccount.agencyId,
      subAccountId,
      type: "ai_skipped",
      content: `AI reply skipped — LLM call failed: ${msg.slice(0, 200)}`,
      meta: { reason: "llm_failed", error: msg.slice(0, 500) },
    });
    return { kind: "skipped", reason: "llm_failed" };
  }

  // Suggest mode: save the reply for a human to approve. Tokens were still spent, so count them.
  if (suggestOnly) {
    await setConversationDraft({
      contactId: contact.id,
      subAccountId,
      agencyId: subAccount.agencyId,
      contactName: contact.name ?? "",
      contactPhone:
        contact.phone ??
        (metaChannel || channelId === "email" ? "" : replyTo),
      channel: conversationChannel,
      body: completion.text,
      model: completion.model,
      tokens: completion.totalTokens,
    });
    // The reply is billed when an operator sends the draft (see upsertConversationForMessage).
    runAfterResponse(() =>
      incrementChannelTokens(subAccountId, channelId, completion.totalTokens, { reply: false }),
    );
    return {
      kind: "drafted",
      replyText: completion.text,
      tokens: completion.totalTokens,
    };
  }

  let send;
  try {
    send = await transport.send({
      subAccountId,
      subAccount,
      to: replyTo,
      body: completion.text,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(
      `[ai/respond] ${transport.label} send failed for sa=${subAccountId}: ${msg}`,
    );
    await logActivity({
      contactId: contact.id,
      agencyId: subAccount.agencyId,
      subAccountId,
      type: "ai_skipped",
      content: `AI reply generated but ${transport.label} send failed: ${msg.slice(0, 200)}`,
      meta: { reason: "llm_failed", sendError: msg.slice(0, 500), channel: channelId },
    });
    return { kind: "skipped", reason: "llm_failed" };
  }

  await storeOutboundReply({
    contactId: contact.id,
    agencyId: subAccount.agencyId,
    subAccountId,
    body: completion.text,
    from: send.from,
    to: replyTo,
    providerSid: send.sid,
    messagesCollection: transport.messagesCollection,
    extras: transport.outboundRowExtras(send.sid),
  });

  // Show the bot's reply as the conversation's latest message.
  await upsertConversationForMessage({
    contactId: contact.id,
    subAccountId,
    agencyId: subAccount.agencyId,
    contactName: contact.name ?? "",
    contactPhone: contact.phone ?? (metaChannel ? null : replyTo),
    channel: conversationChannel,
    direction: "outbound",
    body: completion.text,
  });

  await logActivity({
    contactId: contact.id,
    agencyId: subAccount.agencyId,
    subAccountId,
    type: "ai_reply_sent",
    content: `AI replied via ${transport.label} (${completion.totalTokens} tokens, ${completion.model}).`,
    meta: {
      channel: channelId,
      model: completion.model,
      tokens: completion.totalTokens,
      promptTokens: completion.promptTokens,
      completionTokens: completion.completionTokens,
      providerSid: send.sid,
    },
  });

  runAfterResponse(() => incrementChannelTokens(subAccountId, channelId, completion.totalTokens));

  return {
    kind: "replied",
    replyText: completion.text,
    tokens: completion.totalTokens,
  };
}
