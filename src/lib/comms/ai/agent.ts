import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { recordUsage } from "@/lib/server/usage-meter";
import {
  DEFAULT_AI_AGENT_PROFILE,
  DEFAULT_AI_CHANNEL_CONFIG,
  DEFAULT_VOICE_CONFIG,
  DEFAULT_WEB_CHAT_CONFIG,
  DEFAULT_WHATSAPP_CONFIG,
  type AiAgentProfile,
  type AiChannelConfig,
  type ResolvedAiAgent,
} from "@/types/ai";
import { runAfterResponse } from "@/lib/server/after-response";

const PROFILE_DOC = "profile";
// A literal union avoids an unused runtime array. If one is ever needed,
// export it and derive this type from it.
export type ConfiguredChannelId =
  | "sms"
  | "web-chat"
  | "voice"
  | "whatsapp"
  /**
   * Messenger + Instagram share one doc (`aiAgent/meta`): one Meta connection,
   * and replies go back on whichever platform the DM came from.
   */
  | "meta"
  /**
   * Suggest-only: inbound email produces a pendingDraft for approval and the bot
   * never auto-sends, even in "auto" mode. Needs the two-way inbox (verified
   * sending domain + inboxEnabled).
   */
  | "email";

/**
 * Seed for a new channel doc. Web chat adds widget defaults; voice adds
 * greeting and voice defaults (provider ids stay null until first provisioning).
 */
function defaultsForChannel(
  channelId: ConfiguredChannelId,
): Omit<AiChannelConfig, "createdAt" | "updatedAt"> {
  if (channelId === "web-chat") {
    return { ...DEFAULT_AI_CHANNEL_CONFIG, webChat: { ...DEFAULT_WEB_CHAT_CONFIG } };
  }
  if (channelId === "voice") {
    return { ...DEFAULT_AI_CHANNEL_CONFIG, voice: { ...DEFAULT_VOICE_CONFIG } };
  }
  if (channelId === "whatsapp") {
    return {
      ...DEFAULT_AI_CHANNEL_CONFIG,
      whatsapp: { ...DEFAULT_WHATSAPP_CONFIG },
    };
  }
  return { ...DEFAULT_AI_CHANNEL_CONFIG };
}

// A sub-account-level profile plus per-channel configs that can override it.
// Only this module reads or writes those docs.

function profilePath(subAccountId: string): string {
  return `subAccounts/${subAccountId}/aiAgent/${PROFILE_DOC}`;
}

function channelPath(subAccountId: string, channelId: string): string {
  return `subAccounts/${subAccountId}/aiAgent/${channelId}`;
}

function legacyPath(subAccountId: string): string {
  return `subAccounts/${subAccountId}/aiConfig/main`;
}

/**
 * Split an old `aiConfig/main` doc into profile + sms on first read. The
 * original is left in place so a rollback can still read it.
 */
async function maybeMigrateLegacy(subAccountId: string): Promise<void> {
  const db = getAdminDb();
  const [profileSnap, legacySnap] = await Promise.all([
    db.doc(profilePath(subAccountId)).get(),
    db.doc(legacyPath(subAccountId)).get(),
  ]);
  if (profileSnap.exists) return; // already migrated
  if (!legacySnap.exists) return; // no legacy to migrate

  const legacy = legacySnap.data() as {
    enabled?: boolean;
    systemPrompt?: string;
    businessName?: string;
    hoursStart?: number;
    hoursEnd?: number;
    timezone?: string;
    escalationKeywords?: string[];
    escalationNotifyEmail?: string | null;
    contextMessageCount?: number;
    modelOverride?: string | null;
    totalTokensUsed?: number;
  };

  const profile: AiAgentProfile = {
    systemPrompt: legacy.systemPrompt ?? "",
    businessName: legacy.businessName ?? "",
    hoursStart: legacy.hoursStart ?? 9,
    hoursEnd: legacy.hoursEnd ?? 17,
    timezone: legacy.timezone ?? "Australia/Sydney",
    escalationKeywords: legacy.escalationKeywords ?? [
      ...DEFAULT_AI_AGENT_PROFILE.escalationKeywords,
    ],
    escalationNotifyEmail: legacy.escalationNotifyEmail ?? null,
    websiteUrl: null,
    websiteKb: null,
    websiteKbFetchedAt: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };

  const sms: AiChannelConfig = {
    enabled: legacy.enabled ?? false,
    contextMessageCount: legacy.contextMessageCount ?? 10,
    modelOverride: legacy.modelOverride ?? null,
    escalationKeywordsOverride: null,
    escalationNotifyEmailOverride: null,
    totalTokensUsed: legacy.totalTokensUsed ?? 0,
    webChat: null,
    voice: null,
    whatsapp: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };

  await Promise.all([
    db.doc(profilePath(subAccountId)).set(profile),
    db.doc(channelPath(subAccountId, "sms")).set(sms),
  ]);
  console.log(
    `[ai/agent] migrated legacy aiConfig for sub-account ${subAccountId}`,
  );
}

// Profile (shared identity)

export async function getAgentProfile(
  subAccountId: string,
): Promise<AiAgentProfile | null> {
  await maybeMigrateLegacy(subAccountId);
  const snap = await getAdminDb().doc(profilePath(subAccountId)).get();
  if (!snap.exists) return null;
  return snap.data() as AiAgentProfile;
}

export async function upsertAgentProfile(
  subAccountId: string,
  patch: Partial<AiAgentProfile>,
): Promise<void> {
  await maybeMigrateLegacy(subAccountId);
  const ref = getAdminDb().doc(profilePath(subAccountId));
  const existing = await ref.get();
  const seed = existing.exists
    ? {}
    : {
        ...DEFAULT_AI_AGENT_PROFILE,
        createdAt: FieldValue.serverTimestamp(),
      };
  await ref.set(
    { ...seed, ...patch, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
}

// Per-channel config

export async function getChannelConfig(
  subAccountId: string,
  channelId: ConfiguredChannelId,
): Promise<AiChannelConfig | null> {
  await maybeMigrateLegacy(subAccountId);
  const snap = await getAdminDb()
    .doc(channelPath(subAccountId, channelId))
    .get();
  if (!snap.exists) return null;
  return snap.data() as AiChannelConfig;
}

export async function upsertChannelConfig(
  subAccountId: string,
  channelId: ConfiguredChannelId,
  patch: Partial<AiChannelConfig>,
): Promise<void> {
  await maybeMigrateLegacy(subAccountId);
  const ref = getAdminDb().doc(channelPath(subAccountId, channelId));
  const existing = await ref.get();
  const seed = existing.exists
    ? {}
    : {
        ...defaultsForChannel(channelId),
        createdAt: FieldValue.serverTimestamp(),
      };
  await ref.set(
    { ...seed, ...patch, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
}

export async function incrementChannelTokens(
  subAccountId: string,
  channelId: ConfiguredChannelId,
  tokens: number,
  /** False for spoken turns: voice is priced by the minute, not per reply. */
  opts: { reply?: boolean } = {},
): Promise<void> {
  const isReply = opts.reply ?? channelId !== "voice";
  // One customer-facing reply, even when the provider reported no tokens.
  if (isReply) {
    runAfterResponse(() => recordUsage({ subAccountId, unit: "aiReplies", qty: 1 }));
  }
  if (tokens <= 0) return;
  await getAdminDb()
    .doc(channelPath(subAccountId, channelId))
    .set(
      {
        totalTokensUsed: FieldValue.increment(tokens),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  // Every customer-facing channel ends up here, so this is the single aiTokens
  // meter point. Best-effort; never blocks the reply.
  runAfterResponse(() => recordUsage({ subAccountId, unit: "aiTokens", qty: tokens }));
}


/** Profile + channel merged into one effective config. null if either isn't set up. */
export async function resolveAgent(
  subAccountId: string,
  channelId: ConfiguredChannelId,
): Promise<ResolvedAiAgent | null> {
  await maybeMigrateLegacy(subAccountId);
  const db = getAdminDb();
  const [profileSnap, channelSnap] = await Promise.all([
    db.doc(profilePath(subAccountId)).get(),
    db.doc(channelPath(subAccountId, channelId)).get(),
  ]);
  if (!profileSnap.exists || !channelSnap.exists) return null;

  const profile = profileSnap.data() as AiAgentProfile;
  const channel = channelSnap.data() as AiChannelConfig;

  return {
    profile,
    channel,
    effective: {
      enabled: channel.enabled,
      systemPrompt: profile.systemPrompt,
      businessName: profile.businessName,
      hoursStart: profile.hoursStart,
      hoursEnd: profile.hoursEnd,
      timezone: profile.timezone,
      escalationKeywords:
        channel.escalationKeywordsOverride ?? profile.escalationKeywords,
      escalationNotifyEmail:
        channel.escalationNotifyEmailOverride ?? profile.escalationNotifyEmail,
      contextMessageCount: channel.contextMessageCount,
      modelOverride: channel.modelOverride,
      websiteKb: profile.websiteKb ?? null,
    },
  };
}
