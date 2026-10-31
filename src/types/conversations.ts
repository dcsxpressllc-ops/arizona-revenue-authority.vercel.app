import type { Timestamp, FieldValue } from "firebase/firestore";

/**
 * Unified inbox index at `conversations/{contactId}`. An index, not a message
 * store: messages stay in per-contact subcollections and the detail view
 * merges them at read time. Written by lib/server/conversations-service.ts on
 * every inbound/outbound message.
 *
 * Only created when a real message row is written, so shared-sender SMS (no
 * rows) produces no conversation. Subcollections by channel:
 *   sms -> contacts/{id}/messages, whatsapp -> whatsappMessages,
 *   messenger + instagram -> metaMessages, email -> emailMessages
 *   (only when the sub-account's email inbox is enabled).
 */

/**
 * messenger/instagram only appear with `metaInboxEnabledByAgency` on.
 *
 * web-chat is the exception: it starts as an anonymous session, so its row is
 * keyed `web_{sessionId}` (see `webChatConversationId`) with `contactId` null
 * until capture, and messages live under
 * `subAccounts/{id}/webChatSessions/{sessionId}/messages`.
 */
export type ConversationChannel =
  | "sms"
  | "whatsapp"
  | "messenger"
  | "instagram"
  | "web-chat"
  | "email";

/** Firestore auto-ids never start with this, so it safely marks session-keyed rows. */
export const WEB_CHAT_CONVO_PREFIX = "web_";

export function webChatConversationId(sessionId: string): string {
  return `${WEB_CHAT_CONVO_PREFIX}${sessionId}`;
}

/** Bare sessionId for a web-chat doc id, else null. Avoids a doc read. */
export function parseWebChatConversationId(conversationId: string): string | null {
  return conversationId.startsWith(WEB_CHAT_CONVO_PREFIX)
    ? conversationId.slice(WEB_CHAT_CONVO_PREFIX.length)
    : null;
}

export type ConversationStatus = "open" | "closed" | "snoozed";

/** auto (default): bot replies. suggest: bot drafts into `pendingDraft` for approval. off: silent. */
export type ConversationBotMode = "off" | "suggest" | "auto";

/** Suggest-mode draft. Cleared server-side when a human sends, or on discard. */
export interface ConversationDraft {
  body: string;
  channel: ConversationChannel;
  model: string;
  tokens: number;
  createdAt: Timestamp | FieldValue | null;
}

export interface ConversationDoc {
  id: string;
  /**
   * Equals the doc id for every channel except web-chat, whose rows start null
   * and get a contactId on capture (the doc id stays the session key).
   */
  contactId: string | null;
  /**
   * Web-chat rows only. Its presence tells the inbox to read the session
   * transcript and reply through the web-chat send path.
   */
  sessionId?: string | null;
  /** Title for an anonymous visitor ("Web visitor - pricing page"); null once a contact exists. */
  visitorLabel?: string | null;
  subAccountId: string;
  agencyId: string;
  /** Denormalized so the list skips N contact reads. */
  contactName: string;
  contactPhone: string | null;
  channelsSeen: ConversationChannel[];
  /** Composer default. */
  lastChannel: ConversationChannel;
  lastDirection: "inbound" | "outbound";
  /** First ~120 chars. */
  lastMessagePreview: string;
  /** List sort key, newest first. */
  lastMessageAt: Timestamp | FieldValue | null;
  /** Incremented server-side on inbound; reset client-side on open. */
  unreadCount: number;
  status: ConversationStatus;
  assigneeUid: string | null;
  botMode: ConversationBotMode;
  /** In the future = a human took over and the bot stays quiet. */
  botPausedUntil: Timestamp | FieldValue | null;
  pendingDraft: ConversationDraft | null;
  createdAt: Timestamp | FieldValue | null;
  updatedAt: Timestamp | FieldValue | null;
}
