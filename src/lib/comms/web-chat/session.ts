import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import type { AiChatMessage } from "@/lib/comms/ai/openrouter";
import type {
  WebChatBooking,
  WebChatBookingOffer,
  WebChatMessage,
  WebChatSession,
} from "@/types/web-chat";

/**
 * Web-chat persistence: `subAccounts/{id}/webChatSessions/{sessionId}` with
 * `messages/{messageId}` under it. Upserted on every inbound. contactId stays
 * null until the [[capture ...]] marker fires.
 */

const SESSION_ID_RE = /^[a-zA-Z0-9_-]{16,64}$/;

export function isValidSessionId(s: unknown): s is string {
  return typeof s === "string" && SESSION_ID_RE.test(s);
}

function sessionDocPath(subAccountId: string, sessionId: string): string {
  return `subAccounts/${subAccountId}/webChatSessions/${sessionId}`;
}

export interface SessionCreateInput {
  subAccountId: string;
  agencyId: string;
  sessionId: string;
  pageUrl: string | null;
  referrer: string | null;
  origin: string | null;
  visitorIp: string | null;
  visitorUserAgent: string | null;
}

/** Idempotent. .create() in a try/catch so concurrent first messages don't trample each other. */
export async function getOrCreateSession(
  input: SessionCreateInput,
): Promise<WebChatSession> {
  const ref = getAdminDb().doc(
    sessionDocPath(input.subAccountId, input.sessionId),
  );
  const existing = await ref.get();
  if (existing.exists) {
    return { id: existing.id, ...(existing.data() as Omit<WebChatSession, "id">) };
  }

  const seed: Omit<WebChatSession, "id"> = {
    agencyId: input.agencyId,
    subAccountId: input.subAccountId,
    contactId: null,
    pageUrl: input.pageUrl,
    referrer: input.referrer,
    origin: input.origin,
    visitorIp: input.visitorIp,
    visitorUserAgent: input.visitorUserAgent,
    status: "active",
    messageCount: 0,
    tokensUsed: 0,
    capturedName: null,
    capturedEmail: null,
    capturedPhone: null,
    capturePromptShownAt: null,
    captureSkipped: false,
    pendingFollowUpTaskId: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    lastMessageAt: null,
  };

  try {
    await ref.create(seed);
  } catch {
    // Concurrent create lost the race, so re-read the winning row.
  }

  const snap = await ref.get();
  return { id: snap.id, ...(snap.data() as Omit<WebChatSession, "id">) };
}

/** Returns the new id; the widget uses it to de-dupe against the poll endpoint. */
export async function appendMessage(input: {
  subAccountId: string;
  agencyId: string;
  sessionId: string;
  direction: "inbound" | "outbound";
  body: string;
  tokens: number | null;
  aiGenerated: boolean;
  /** Web Voice turns only. */
  via?: "voice";
}): Promise<string> {
  const db = getAdminDb();
  const sessionRef = db.doc(
    sessionDocPath(input.subAccountId, input.sessionId),
  );
  const msgRef = sessionRef.collection("messages").doc();

  const batch = db.batch();
  batch.set(msgRef, {
    agencyId: input.agencyId,
    subAccountId: input.subAccountId,
    sessionId: input.sessionId,
    direction: input.direction,
    body: input.body,
    tokens: input.tokens,
    aiGenerated: input.aiGenerated,
    ...(input.via ? { via: input.via } : {}),
    createdAt: FieldValue.serverTimestamp(),
  });
  batch.update(sessionRef, {
    messageCount: FieldValue.increment(1),
    tokensUsed: input.tokens ? FieldValue.increment(input.tokens) : FieldValue.increment(0),
    lastMessageAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  await batch.commit();
  return msgRef.id;
}

/** Last N messages for the LLM, excluding the just-arrived inbound so the model sees it once (as the final user turn). */
export async function loadRecentHistory(
  subAccountId: string,
  sessionId: string,
  limit: number,
  excludeBody: string,
): Promise<AiChatMessage[]> {
  const safeLimit = Math.max(1, Math.min(50, limit));
  const snap = await getAdminDb()
    .doc(sessionDocPath(subAccountId, sessionId))
    .collection("messages")
    .orderBy("createdAt", "desc")
    .limit(safeLimit + 1)
    .get();

  const docs = snap.docs.reverse();
  const turns: AiChatMessage[] = [];
  for (const d of docs) {
    const data = d.data() as WebChatMessage;
    if (!data.body) continue;
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

/** Idempotent; keeps the original timestamp. */
export async function markCapturePromptShown(input: {
  subAccountId: string;
  sessionId: string;
}): Promise<void> {
  await getAdminDb()
    .doc(sessionDocPath(input.subAccountId, input.sessionId))
    .set(
      {
        capturePromptShownAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
}

/** Visitor skipped the inline form; don't ask again. */
export async function markCaptureSkipped(input: {
  subAccountId: string;
  sessionId: string;
}): Promise<void> {
  await getAdminDb()
    .doc(sessionDocPath(input.subAccountId, input.sessionId))
    .set(
      {
        captureSkipped: true,
        capturePromptShownAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
}

export async function linkSessionToContact(input: {
  subAccountId: string;
  sessionId: string;
  contactId: string;
  capturedName: string | null;
  capturedEmail: string | null;
  capturedPhone: string | null;
  /** The session moved to a different contact: write all three, nulls included. */
  replaceCaptured?: boolean;
}): Promise<void> {
  // Otherwise null means "not given this time", so keep what was captured earlier.
  const captured = input.replaceCaptured
    ? {
        capturedName: input.capturedName,
        capturedEmail: input.capturedEmail,
        capturedPhone: input.capturedPhone,
      }
    : {
        ...(input.capturedName ? { capturedName: input.capturedName } : {}),
        ...(input.capturedEmail ? { capturedEmail: input.capturedEmail } : {}),
        ...(input.capturedPhone ? { capturedPhone: input.capturedPhone } : {}),
      };
  await getAdminDb()
    .doc(sessionDocPath(input.subAccountId, input.sessionId))
    .update({
      contactId: input.contactId,
      ...captured,
      updatedAt: FieldValue.serverTimestamp(),
    });
}

/** Remember the times just offered (null clears them). */
export async function setBookingOffer(input: {
  subAccountId: string;
  sessionId: string;
  offer: WebChatBookingOffer | null;
}): Promise<void> {
  await getAdminDb()
    .doc(sessionDocPath(input.subAccountId, input.sessionId))
    .set(
      { bookingOffer: input.offer, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
}

/** Append a booking and clear the offer it came from. */
export async function recordSessionBooking(input: {
  subAccountId: string;
  sessionId: string;
  booking: WebChatBooking;
}): Promise<void> {
  await getAdminDb()
    .doc(sessionDocPath(input.subAccountId, input.sessionId))
    .set(
      {
        bookings: FieldValue.arrayUnion(input.booking),
        bookingOffer: null,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
}
