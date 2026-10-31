import "server-only";

import { randomBytes } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { checkThresholds, usageMonthKey } from "@/lib/server/usage-meter";
import { ElevenLabsError, getConversation } from "@/lib/web-voice/elevenlabs";
import {
  WEB_VOICE_LIMITS,
  webVoiceUsagePath,
  type WebVoiceConnectionSecret,
  type WebVoiceUsageDoc,
} from "@/types/web-voice";

/**
 * Web Voice minute accounting and caps, one server-only doc per sub-account
 * (private/webVoiceUsage), updated in transactions.
 *
 * Per conversation:
 *   1. /voice/start -> reserveGrant(): cap + concurrency check, record a grant
 *      (an unused signed URL still counts toward concurrency).
 *   2. /voice/event connected -> markConnected(): grant becomes pending, keyed
 *      by the ElevenLabs conversation id.
 *   3. /voice/event ended (or a later sweep) -> settleConversation(): duration
 *      read from ElevenLabs, never the browser, and counted once.
 *
 * Pending conversations are assumed to run the full maxCallSeconds until
 * settled, so concurrent callers can't overshoot the daily cap. Days are UTC.
 */

/** Unclaimed grants older than this are abandoned (signed URL unused). */
const GRANT_LIVE_MS = 2 * 60 * 1000;
/** Claimable up to the signed-URL lifetime. */
const GRANT_MAX_MS = 16 * 60 * 1000;
/** Dedupe ring for repeated /end beacons. */
const SETTLED_RING = 200;

export class WebVoiceLimitError extends Error {
  constructor(
    message: string,
    public reason: "daily_cap" | "busy",
  ) {
    super(message);
    this.name = "WebVoiceLimitError";
  }
}

function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}
function utcMonth(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

function emptyUsage(): WebVoiceUsageDoc {
  return {
    day: utcDay(),
    secondsToday: 0,
    month: utcMonth(),
    secondsThisMonth: 0,
    pending: {},
    grants: {},
    settled: [],
  };
}

/** Also rolls the day/month counters over. */
function normalise(raw: Partial<WebVoiceUsageDoc> | undefined): WebVoiceUsageDoc {
  const u: WebVoiceUsageDoc = { ...emptyUsage(), ...(raw ?? {}) };
  u.pending = { ...(u.pending ?? {}) };
  u.grants = { ...(u.grants ?? {}) };
  u.settled = Array.isArray(u.settled) ? [...u.settled] : [];
  if (u.day !== utcDay()) {
    u.day = utcDay();
    u.secondsToday = 0;
  }
  if (u.month !== utcMonth()) {
    u.month = utcMonth();
    u.secondsThisMonth = 0;
  }
  const now = Date.now();
  for (const [id, at] of Object.entries(u.grants)) {
    if (now - at > GRANT_MAX_MS) delete u.grants[id];
  }
  return u;
}

function liveGrantCount(u: WebVoiceUsageDoc): number {
  const now = Date.now();
  return Object.values(u.grants).filter((at) => now - at <= GRANT_LIVE_MS).length;
}

/** Includes reservations. */
function committedSeconds(u: WebVoiceUsageDoc, maxCallSeconds: number): number {
  const reserved =
    (Object.keys(u.pending).length + liveGrantCount(u)) * maxCallSeconds;
  return u.secondsToday + reserved;
}

/** Cheap check for the widget config: room for one more call? */
export async function webVoiceCapReached(
  subAccountId: string,
  conn: Pick<WebVoiceConnectionSecret, "dailyMinuteCap" | "maxCallSeconds">,
): Promise<boolean> {
  const snap = await getAdminDb().doc(webVoiceUsagePath(subAccountId)).get();
  const u = normalise(snap.data() as Partial<WebVoiceUsageDoc> | undefined);
  // Only settled seconds hide the mic, so live reservations don't make the button
  // flicker for everyone else.
  return u.secondsToday + conn.maxCallSeconds > conn.dailyMinuteCap * 60;
}

export async function getWebVoiceUsage(subAccountId: string): Promise<{
  secondsToday: number;
  secondsThisMonth: number;
  activeNow: number;
}> {
  const snap = await getAdminDb().doc(webVoiceUsagePath(subAccountId)).get();
  const u = normalise(snap.data() as Partial<WebVoiceUsageDoc> | undefined);
  return {
    secondsToday: u.secondsToday,
    secondsThisMonth: u.secondsThisMonth,
    activeNow: Object.keys(u.pending).length,
  };
}

/** Throws WebVoiceLimitError. */
export async function reserveGrant(
  subAccountId: string,
  conn: Pick<WebVoiceConnectionSecret, "dailyMinuteCap" | "maxCallSeconds">,
): Promise<string> {
  const db = getAdminDb();
  const ref = db.doc(webVoiceUsagePath(subAccountId));
  const grantId = randomBytes(12).toString("base64url");
  await db.runTransaction(async (tx) => {
    const u = normalise((await tx.get(ref)).data() as Partial<WebVoiceUsageDoc> | undefined);
    const active = Object.keys(u.pending).length + liveGrantCount(u);
    if (active >= WEB_VOICE_LIMITS.concurrency) {
      throw new WebVoiceLimitError(
        "Voice is busy right now — please type your message instead.",
        "busy",
      );
    }
    if (committedSeconds(u, conn.maxCallSeconds) + conn.maxCallSeconds > conn.dailyMinuteCap * 60) {
      throw new WebVoiceLimitError(
        "Voice isn't available right now — please type your message instead.",
        "daily_cap",
      );
    }
    u.grants[grantId] = Date.now();
    tx.set(ref, u);
  });
  return grantId;
}

export async function markConnected(input: {
  subAccountId: string;
  grantId: string;
  conversationId: string;
  sessionId: string;
}): Promise<boolean> {
  const db = getAdminDb();
  const ref = db.doc(webVoiceUsagePath(input.subAccountId));
  return db.runTransaction(async (tx) => {
    const u = normalise((await tx.get(ref)).data() as Partial<WebVoiceUsageDoc> | undefined);
    if (u.settled.includes(input.conversationId)) return false;
    if (u.pending[input.conversationId]) return false;
    // Only an outstanding grant can be claimed, so a replayed token can't register
    // extra conversations.
    if (!(input.grantId in u.grants)) return false;
    delete u.grants[input.grantId];
    u.pending[input.conversationId] = {
      sessionId: input.sessionId,
      startedAtMs: Date.now(),
    };
    tx.set(ref, u);
    return true;
  });
}

/** Count one conversation's real duration from ElevenLabs, once. Stays pending if
 *  no duration yet (the sweep retries). Unknown ids are ignored. */
export async function settleConversation(input: {
  subAccountId: string;
  conversationId: string;
  conn: Pick<WebVoiceConnectionSecret, "apiKey" | "agentId">;
  /** Counted when lookups keep failing past the give-up window. */
  maxCallSeconds?: number;
}): Promise<void> {
  const db = getAdminDb();
  const ref = db.doc(webVoiceUsagePath(input.subAccountId));
  const before = normalise((await ref.get()).data() as Partial<WebVoiceUsageDoc> | undefined);
  const pending = before.pending[input.conversationId];
  if (!pending) return;

  // Past the longest possible call (+2 min) it has definitely ended.
  const stale =
    input.maxCallSeconds !== undefined &&
    Date.now() - pending.startedAtMs > (input.maxCallSeconds + 120) * 1000;

  let seconds: number | null = null;
  // Only a duration ElevenLabs reported is billable; fallbacks just keep the cap honest.
  let billable = false;
  try {
    const conv = await getConversation(input.conn.apiKey, input.conversationId);
    const live = conv.status === "initiated" || conv.status === "in-progress";
    if (conv.agentId && input.conn.agentId && conv.agentId !== input.conn.agentId) {
      seconds = 0; // not ours: release the reservation without counting
    } else if (live && !stale) {
      return; // still talking, keep the reservation
    } else if (conv.durationSeconds !== null) {
      seconds = conv.durationSeconds;
      billable = true;
    } else if (conv.status === "failed") {
      seconds = 0;
    } else if (stale) {
      seconds = input.maxCallSeconds ?? 0;
    }
  } catch (err) {
    if (err instanceof ElevenLabsError && err.status === 404) {
      // Not a conversation on this account; release it.
      seconds = 0;
    } else if (Date.now() - pending.startedAtMs > 30 * 60 * 1000) {
      // Still failing long after any call could end: release the slot but count the
      // full reservation so the cap stays honest.
      seconds = input.maxCallSeconds ?? 0;
    } else {
      console.warn(
        `[web-voice] duration lookup failed sa=${input.subAccountId} conv=${input.conversationId}`,
        err,
      );
      return;
    }
  }
  if (seconds === null) return;
  const counted = Math.max(0, Math.round(seconds));

  const applied = await db.runTransaction(async (tx) => {
    const u = normalise((await tx.get(ref)).data() as Partial<WebVoiceUsageDoc> | undefined);
    if (!u.pending[input.conversationId]) return false;
    delete u.pending[input.conversationId];
    u.secondsToday += counted;
    u.secondsThisMonth += counted;
    u.settled = [...u.settled, input.conversationId].slice(-SETTLED_RING);
    tx.set(ref, u);
    // In the same transaction, so only the settle that cleared the pending entry bills it.
    if (billable && counted > 0) {
      tx.set(
        db.doc(`subAccounts/${input.subAccountId}/usage/${usageMonthKey()}`),
        {
          webVoiceSeconds: FieldValue.increment(counted),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }
    return true;
  });

  if (applied && billable && counted > 0) {
    await checkThresholds(input.subAccountId, "webVoiceSeconds");
  }
  if (applied && counted > 0) {
    await db
      .doc(`subAccounts/${input.subAccountId}/webChatSessions/${pending.sessionId}`)
      .set(
        {
          voiceSeconds: FieldValue.increment(counted),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      )
      .catch(() => {});
  }
}

/**
 * Settle finished pending conversations (tab closed before the end ping, or the
 * duration wasn't final yet). Called from /voice/start so caps stay accurate
 * without a cron; pending is bounded by concurrency, so only a few reads.
 */
export async function sweepStalePending(input: {
  subAccountId: string;
  conn: Pick<WebVoiceConnectionSecret, "apiKey" | "agentId" | "maxCallSeconds">;
}): Promise<void> {
  const snap = await getAdminDb().doc(webVoiceUsagePath(input.subAccountId)).get();
  const u = normalise(snap.data() as Partial<WebVoiceUsageDoc> | undefined);
  // Calls that started seconds ago are still live.
  const cutoff = Date.now() - 15_000;
  const stale = Object.entries(u.pending)
    .filter(([, p]) => p.startedAtMs < cutoff)
    .slice(0, 5)
    .map(([id]) => id);
  await Promise.all(
    stale.map((conversationId) =>
      settleConversation({
        subAccountId: input.subAccountId,
        conversationId,
        conn: input.conn,
        maxCallSeconds: input.conn.maxCallSeconds,
      }),
    ),
  );
}
