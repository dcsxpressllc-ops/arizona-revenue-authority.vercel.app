import {
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  type Unsubscribe,
} from "firebase/firestore";
import { getFirebaseDb } from "@/lib/firebase/client";
import type { WebChatMessage, WebChatSession } from "@/types/web-chat";

/**
 * Client onSnapshot helpers for the operator console over
 * `subAccounts/{saId}/webChatSessions/{sid}` and its `messages`. Rules limit
 * access to sub-account members.
 *
 * Sessions sort client-side by lastMessageAt: an indexed orderBy can flake on
 * the first listener after deploy while Firestore builds the auto index.
 * Messages use a server orderBy createdAt asc.
 */

function sessionCollectionPath(subAccountId: string): string {
  return `subAccounts/${subAccountId}/webChatSessions`;
}

function sessionDocPath(subAccountId: string, sessionId: string): string {
  return `${sessionCollectionPath(subAccountId)}/${sessionId}`;
}

export function subscribeToWebChatSessions(
  subAccountId: string,
  callback: (sessions: WebChatSession[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  const q = collection(getFirebaseDb(), sessionCollectionPath(subAccountId));
  return onSnapshot(
    q,
    (snap) => {
      const sessions = snap.docs.map(
        (d) => ({ id: d.id, ...(d.data() as Omit<WebChatSession, "id">) }),
      );
      sessions.sort(
        (a, b) =>
          toMillis(b.lastMessageAt ?? b.createdAt) -
          toMillis(a.lastMessageAt ?? a.createdAt),
      );
      callback(sessions);
    },
    (err) => onError?.(err),
  );
}

export function subscribeToWebChatSession(
  subAccountId: string,
  sessionId: string,
  callback: (session: WebChatSession | null) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  return onSnapshot(
    doc(getFirebaseDb(), sessionDocPath(subAccountId, sessionId)),
    (snap) => {
      if (!snap.exists()) {
        callback(null);
        return;
      }
      callback({ id: snap.id, ...(snap.data() as Omit<WebChatSession, "id">) });
    },
    (err) => onError?.(err),
  );
}

export function subscribeToWebChatMessages(
  subAccountId: string,
  sessionId: string,
  callback: (messages: WebChatMessage[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  const q = query(
    collection(
      getFirebaseDb(),
      `${sessionDocPath(subAccountId, sessionId)}/messages`,
    ),
    orderBy("createdAt", "asc"),
  );
  return onSnapshot(
    q,
    (snap) => {
      const messages = snap.docs.map(
        (d) => ({ id: d.id, ...(d.data() as Omit<WebChatMessage, "id">) }),
      );
      callback(messages);
    },
    (err) => onError?.(err),
  );
}

function toMillis(v: unknown): number {
  if (!v) return 0;
  if (v instanceof Date) return v.getTime();
  const maybe = v as { toDate?: () => Date; seconds?: number };
  if (typeof maybe.toDate === "function") return maybe.toDate().getTime();
  if (typeof maybe.seconds === "number") return maybe.seconds * 1000;
  return 0;
}
