import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { emitWebhookEvent } from "@/lib/api/webhooks/dispatch";
import {
  fireWorkflowTrigger,
  resumeWaitingRunsOnReply,
} from "@/lib/workflows/engine";
import type {
  ConversationBotMode,
  ConversationChannel,
} from "@/types/conversations";
import { runAfterResponse } from "@/lib/server/after-response";
import { checkThresholds, usageMonthKey } from "@/lib/server/usage-meter";

/** A human reply pauses the bot on that conversation for this long (or until Resume). */
const PAUSE_WINDOW_MS = 12 * 60 * 60 * 1000;

/**
 * Unified-inbox index write, called after every message-row write. Must never
 * break the send/receive, so callers void it. Doc id is the contactId by
 * default. Immutable fields are stamped once in a get-or-create transaction;
 * rolling state is merged and inbound increments unreadCount.
 */

const PREVIEW_MAX = 120;

export interface UpsertConversationInput {
  /** Null for an anonymous web-chat session; then `conversationKey` is required. */
  contactId: string | null;
  /**
   * Doc id override, defaults to contactId. Web chat passes
   * webChatConversationId(sessionId) so anonymous threads have a stable key, kept
   * after capture since doc ids are immutable.
   */
  conversationKey?: string;
  /** Web chat only. */
  sessionId?: string | null;
  /** Web chat only: label while anonymous. */
  visitorLabel?: string | null;
  subAccountId: string;
  agencyId: string;
  contactName: string;
  contactPhone: string | null;
  channel: ConversationChannel;
  direction: "inbound" | "outbound";
  body: string;
  /** Human operator reply: pauses the bot for PAUSE_WINDOW_MS, marks read, clears
   *  any AI draft. False for the bot's own replies. */
  pauseBot?: boolean;
  /** Operator sent the AI draft from the inbox: bills one AI reply if a draft was pending. */
  approvedDraft?: boolean;
}

export async function upsertConversationForMessage(
  input: UpsertConversationInput,
): Promise<void> {
  try {
    const db = getAdminDb();
    const docId = input.conversationKey ?? input.contactId;
    if (!docId) {
      console.warn("[conversations/upsert] no contactId or conversationKey");
      return;
    }
    const ref = db.collection("conversations").doc(docId);
    const preview =
      input.body.length > PREVIEW_MAX
        ? `${input.body.slice(0, PREVIEW_MAX)}…`
        : input.body;

    const billedDraft = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);

      const patch: Record<string, unknown> = {
        contactId: input.contactId,
        subAccountId: input.subAccountId,
        agencyId: input.agencyId,
        contactName: input.contactName,
        contactPhone: input.contactPhone,
        channelsSeen: FieldValue.arrayUnion(input.channel),
        // Only written when supplied, so contact-keyed rows never get these keys.
        ...(input.sessionId !== undefined
          ? { sessionId: input.sessionId }
          : {}),
        ...(input.visitorLabel !== undefined
          ? { visitorLabel: input.visitorLabel }
          : {}),
        lastChannel: input.channel,
        lastDirection: input.direction,
        lastMessagePreview: preview,
        lastMessageAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };

      if (input.direction === "inbound") {
        // increment() on a missing field initializes it to 1.
        patch.unreadCount = FieldValue.increment(1);
      }

      if (input.pauseBot) {
        // A human took over: pause the bot, mark read, drop any stale draft.
        patch.botPausedUntil = new Date(Date.now() + PAUSE_WINDOW_MS);
        patch.unreadCount = 0;
        patch.pendingDraft = null;
      }

      if (!snap.exists) {
        patch.createdAt = FieldValue.serverTimestamp();
        patch.status = "open";
        patch.assigneeUid = null;
        patch.botMode = "auto"; // reserved for Phase 2
        patch.botPausedUntil = null;
        // First message is outbound, so nothing unread.
        if (input.direction !== "inbound") patch.unreadCount = 0;
      }

      tx.set(ref, patch, { merge: true });

      // Same transaction that clears the draft, so a double click can't bill twice.
      if (
        input.approvedDraft &&
        input.pauseBot &&
        input.direction === "outbound" &&
        snap.data()?.pendingDraft
      ) {
        tx.set(
          db.doc(`subAccounts/${input.subAccountId}/usage/${usageMonthKey()}`),
          {
            aiReplies: FieldValue.increment(1),
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
        return true;
      }
      return false;
    });
    if (billedDraft) {
      runAfterResponse(() => checkThresholds(input.subAccountId, "aiReplies"));
    }

    // Every inbound message passes through here, so this is the single emit point
    // for message.received and the speed-to-lead push. Runs after the index write
    // and self-guarded so it can't break the inbound webhook. Everything below is
    // contact-keyed, so anonymous web-chat sessions are skipped until capture.
    if (input.direction === "inbound" && input.contactId) {
      const contactId = input.contactId;
      void emitWebhookEvent({
        subAccountId: input.subAccountId,
        agencyId: input.agencyId,
        mode: "live",
        type: "message.received",
        payload: {
          message: {
            object: "message",
            contact_id: contactId,
            contact_name: input.contactName,
            channel: input.channel,
            preview: preview,
          },
        },
      });
      // Resolves any run parked on wait_for_reply. Self-guarded.
      runAfterResponse(() => resumeWaitingRunsOnReply({
        subAccountId: input.subAccountId,
        contactId,
        channel: input.channel,
      }));
      // Channel filter is applied inside fireWorkflowTrigger.
      void fireWorkflowTrigger({
        subAccountId: input.subAccountId,
        agencyId: input.agencyId,
        type: "message.received",
        contactId,
        context: { channel: input.channel },
      });
    }
  } catch (err) {
    console.warn("[conversations/upsert] failed", err);
  }
}

/**
 * AI controls for the orchestrator. Missing doc/fields mean "auto" and not
 * paused. `conversationId` is the doc id (contactId, or the web-chat key).
 */
export async function getConversationControls(
  conversationId: string,
): Promise<{ botMode: ConversationBotMode; botPausedUntilMs: number | null }> {
  try {
    const snap = await getAdminDb()
      .collection("conversations")
      .doc(conversationId)
      .get();
    if (!snap.exists) return { botMode: "auto", botPausedUntilMs: null };
    const d = snap.data() ?? {};
    const botMode = (d.botMode as ConversationBotMode) ?? "auto";
    const bp = d.botPausedUntil as { toMillis?: () => number } | null | undefined;
    const botPausedUntilMs =
      bp && typeof bp.toMillis === "function" ? bp.toMillis() : null;
    return { botMode, botPausedUntilMs };
  } catch (err) {
    console.warn("[conversations/controls] read failed", err);
    return { botMode: "auto", botPausedUntilMs: null };
  }
}

/**
 * Suggest-mode draft for a human to approve. The inbound upsert already created
 * the doc, but tenancy + denorm fields are written anyway.
 */
export async function setConversationDraft(input: {
  contactId: string | null;
  /** Web chat passes its session key (see upsert). */
  conversationKey?: string;
  sessionId?: string | null;
  visitorLabel?: string | null;
  subAccountId: string;
  agencyId: string;
  contactName: string;
  contactPhone: string | null;
  channel: ConversationChannel;
  body: string;
  model: string;
  tokens: number;
}): Promise<void> {
  try {
    const docId = input.conversationKey ?? input.contactId;
    if (!docId) return;
    await getAdminDb()
      .collection("conversations")
      .doc(docId)
      .set(
        {
          contactId: input.contactId,
          subAccountId: input.subAccountId,
          agencyId: input.agencyId,
          contactName: input.contactName,
          contactPhone: input.contactPhone,
          ...(input.sessionId !== undefined
            ? { sessionId: input.sessionId }
            : {}),
          ...(input.visitorLabel !== undefined
            ? { visitorLabel: input.visitorLabel }
            : {}),
          pendingDraft: {
            body: input.body,
            channel: input.channel,
            model: input.model,
            tokens: input.tokens,
            createdAt: FieldValue.serverTimestamp(),
          },
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
  } catch (err) {
    console.warn("[conversations/draft] write failed", err);
  }
}
