import {
  collection,
  doc,
  onSnapshot,
  type Unsubscribe,
} from "firebase/firestore";
import { getFirebaseDb } from "@/lib/firebase/client";
import type { VoiceCall } from "@/types/voice";

/**
 * Client onSnapshot helpers for the Voice console over
 * `subAccounts/{saId}/voiceCalls/{callId}` (rules limit to members). Sorted
 * client-side, newest first, like web-chat-sessions.ts, to dodge flaky first
 * listeners while auto indexes build.
 */

function callCollectionPath(subAccountId: string): string {
  return `subAccounts/${subAccountId}/voiceCalls`;
}

function callDocPath(subAccountId: string, callId: string): string {
  return `${callCollectionPath(subAccountId)}/${callId}`;
}

export function subscribeToVoiceCalls(
  subAccountId: string,
  callback: (calls: VoiceCall[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  const q = collection(getFirebaseDb(), callCollectionPath(subAccountId));
  return onSnapshot(
    q,
    (snap) => {
      const calls = snap.docs.map(
        (d) => ({ id: d.id, ...(d.data() as Omit<VoiceCall, "id">) }),
      );
      calls.sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));
      callback(calls);
    },
    (err) => onError?.(err),
  );
}

export function subscribeToVoiceCall(
  subAccountId: string,
  callId: string,
  callback: (call: VoiceCall | null) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  return onSnapshot(
    doc(getFirebaseDb(), callDocPath(subAccountId, callId)),
    (snap) => {
      if (!snap.exists()) {
        callback(null);
        return;
      }
      callback({ id: snap.id, ...(snap.data() as Omit<VoiceCall, "id">) });
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
