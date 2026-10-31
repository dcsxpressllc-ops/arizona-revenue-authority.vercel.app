import {
  collection,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  updateDoc,
  where,
  type Unsubscribe,
} from "firebase/firestore";
import { getFirebaseDb } from "@/lib/firebase/client";
import type {
  ConversationBotMode,
  ConversationDoc,
} from "@/types/conversations";

const CONVERSATIONS = "conversations";

/** Filters on subAccountId only and sorts client-side, like subscribeToContacts, to avoid a composite index. */
export function subscribeToConversations(
  subAccountId: string,
  callback: (conversations: ConversationDoc[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  const q = query(
    collection(getFirebaseDb(), CONVERSATIONS),
    where("subAccountId", "==", subAccountId),
  );
  return onSnapshot(
    q,
    (snap) => {
      const rows = snap.docs.map(
        (d) => ({ id: d.id, ...(d.data() as Omit<ConversationDoc, "id">) }),
      );
      rows.sort((a, b) => toMillis(b.lastMessageAt) - toMillis(a.lastMessageAt));
      callback(rows);
    },
    (err) => onError?.(err),
  );
}

/** Doc id == contactId. */
export function subscribeToConversation(
  contactId: string,
  callback: (conversation: ConversationDoc | null) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  return onSnapshot(
    doc(getFirebaseDb(), CONVERSATIONS, contactId),
    (snap) => {
      callback(
        snap.exists()
          ? { id: snap.id, ...(snap.data() as Omit<ConversationDoc, "id">) }
          : null,
      );
    },
    (err) => onError?.(err),
  );
}

/** On thread open. Best-effort (a blip leaves a stale badge). Rules only allow clients to touch the operator-facing fields. */
export async function markConversationRead(contactId: string): Promise<void> {
  try {
    await updateDoc(doc(getFirebaseDb(), CONVERSATIONS, contactId), {
      unreadCount: 0,
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    console.warn("[conversations] mark-read failed", err);
  }
}

export async function setConversationBotMode(
  contactId: string,
  mode: ConversationBotMode,
): Promise<void> {
  try {
    await updateDoc(doc(getFirebaseDb(), CONVERSATIONS, contactId), {
      botMode: mode,
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    console.warn("[conversations] set bot mode failed", err);
  }
}

export async function resumeBot(contactId: string): Promise<void> {
  try {
    await updateDoc(doc(getFirebaseDb(), CONVERSATIONS, contactId), {
      botPausedUntil: null,
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    console.warn("[conversations] resume bot failed", err);
  }
}

/** Drops a pending suggest-mode draft without sending. */
export async function discardConversationDraft(
  contactId: string,
): Promise<void> {
  try {
    await updateDoc(doc(getFirebaseDb(), CONVERSATIONS, contactId), {
      pendingDraft: null,
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    console.warn("[conversations] discard draft failed", err);
  }
}

function toMillis(v: unknown): number {
  if (!v) return 0;
  if (v instanceof Date) return v.getTime();
  const maybe = v as { toDate?: () => Date; seconds?: number };
  if (typeof maybe.toDate === "function") return maybe.toDate().getTime();
  if (typeof maybe.seconds === "number") return maybe.seconds * 1000;
  return 0;
}
