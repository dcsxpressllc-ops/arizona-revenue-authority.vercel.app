import "server-only";

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { aiIsConfigured, callAi } from "@/lib/comms/ai/openrouter";
import { getAgentProfile } from "@/lib/comms/ai/agent";
import { createTaskServerSide } from "@/lib/server/tasks-service";
import { sendPushForEvent } from "@/lib/push/send";
import {
  WATCHDOG_DEFAULT_DAILY_TOKEN_BUDGET,
  WATCHDOG_DEFAULT_THRESHOLD_HOURS,
  WATCHDOG_MAX_JUDGMENTS_PER_RUN,
  type WatchdogConfigDoc,
  type WatchdogConfigResponse,
  type WatchdogQuietHours,
  type WatchdogRunAction,
  type WatchdogRunDoc,
  type WatchdogRunResponse,
  type WatchdogSkippedReason,
} from "@/types/custom-agents";
import type { ConversationChannel, ConversationDoc } from "@/types/conversations";
import type { SubAccountDoc } from "@/types";
import { runAfterResponse } from "@/lib/server/after-response";

/**
 * Inbox follow-up watchdog (Labs autonomous agent).
 *
 * Safety invariants, don't relax these:
 *   1. Additive-internal actions only: Task, team push, activity row, dedupe
 *      stamp. It never messages a customer or edits a record.
 *   2. subAccountId comes from the agent doc id, never from model output.
 *   3. The LLM only classifies. Strict JSON, clamped fields; unparseable means
 *      "no follow-up needed".
 *   4. Cost bounds: deterministic pre-filter, at most 20 judgments per run, a
 *      daily token budget, gates re-checked every run.
 */

const AGENTS_COLLECTION = "customAgents";
/** Shortlist is capped later at MAX_JUDGMENTS. */
const PREFILTER_FETCH_LIMIT = 60;
/** Last N messages fed to the judge. */
const THREAD_EXCERPT_MESSAGES = 5;
const MAX_RUNS_KEPT_DAYS = 30;

function agentRef(subAccountId: string) {
  return getAdminDb().collection(AGENTS_COLLECTION).doc(subAccountId);
}

// Config (admin API route)

export function serializeWatchdogConfig(
  data: Partial<WatchdogConfigDoc> | undefined,
): WatchdogConfigResponse {
  return {
    enabled: data?.enabled === true,
    thresholdHours:
      typeof data?.thresholdHours === "number"
        ? data.thresholdHours
        : WATCHDOG_DEFAULT_THRESHOLD_HOURS,
    instructions: data?.instructions ?? null,
    quietHours: data?.quietHours ?? null,
    dailyTokenBudget:
      typeof data?.dailyTokenBudget === "number"
        ? data.dailyTokenBudget
        : WATCHDOG_DEFAULT_DAILY_TOKEN_BUDGET,
    totalTokensUsed:
      typeof data?.totalTokensUsed === "number" ? data.totalTokensUsed : 0,
  };
}

export async function getWatchdogConfig(
  subAccountId: string,
): Promise<WatchdogConfigResponse> {
  const snap = await agentRef(subAccountId).get();
  return serializeWatchdogConfig(snap.data() as Partial<WatchdogConfigDoc>);
}

export async function upsertWatchdogConfig(
  subAccountId: string,
  agencyId: string,
  patch: Partial<
    Pick<
      WatchdogConfigDoc,
      "enabled" | "thresholdHours" | "instructions" | "quietHours"
    >
  >,
): Promise<WatchdogConfigResponse> {
  const ref = agentRef(subAccountId);
  const snap = await ref.get();
  if (!snap.exists) {
    await ref.set({
      subAccountId,
      agencyId,
      enabled: false,
      thresholdHours: WATCHDOG_DEFAULT_THRESHOLD_HOURS,
      instructions: null,
      quietHours: null,
      dailyTokenBudget: WATCHDOG_DEFAULT_DAILY_TOKEN_BUDGET,
      tokensTodayDate: null,
      tokensToday: 0,
      totalTokensUsed: 0,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    } satisfies Omit<WatchdogConfigDoc, "createdAt" | "updatedAt"> & {
      createdAt: FieldValue;
      updatedAt: FieldValue;
    });
  }
  await ref.update({ ...patch, updatedAt: FieldValue.serverTimestamp() });
  const updated = await ref.get();
  return serializeWatchdogConfig(updated.data() as Partial<WatchdogConfigDoc>);
}

function tsToIso(value: unknown): string | null {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  return null;
}

export async function listWatchdogRuns(
  subAccountId: string,
  limit = 10,
): Promise<WatchdogRunResponse[]> {
  const snap = await agentRef(subAccountId)
    .collection("runs")
    .orderBy("startedAt", "desc")
    .limit(limit)
    .get();
  return snap.docs.map((d) => {
    const data = d.data() as WatchdogRunDoc;
    return {
      id: d.id,
      status: data.status,
      skippedReason: data.skippedReason ?? null,
      scanned: data.scanned ?? 0,
      judged: data.judged ?? 0,
      flagged: data.flagged ?? 0,
      actions: data.actions ?? [],
      tokensUsed: data.tokensUsed ?? 0,
      startedAt: tsToIso(data.startedAt),
      finishedAt: tsToIso(data.finishedAt),
    };
  });
}

// Hourly sweep

const CHANNEL_COLLECTION: Record<ConversationChannel, string> = {
  sms: "messages",
  whatsapp: "whatsappMessages",
  messenger: "metaMessages",
  instagram: "metaMessages",
  // Never read: web-chat candidates are filtered out below.
  "web-chat": "messages",
  email: "emailMessages",
};

interface JudgeVerdict {
  needsFollowUp: boolean;
  urgency: "high" | "normal";
  reason: string;
}

/** Unparseable output returns null ("no follow-up") so a rambling model can't
 *  force an alert. */
function parseVerdict(text: string): JudgeVerdict | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const raw = JSON.parse(match[0]) as Record<string, unknown>;
    if (typeof raw.needsFollowUp !== "boolean") return null;
    return {
      needsFollowUp: raw.needsFollowUp,
      urgency: raw.urgency === "high" ? "high" : "normal",
      reason:
        typeof raw.reason === "string"
          ? raw.reason.trim().slice(0, 140)
          : "Unanswered inbound conversation",
    };
  } catch {
    return null;
  }
}

/** Falls back to UTC on a bad timezone. */
function hourInTz(timezone: string, at: Date): number {
  try {
    const part = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone: timezone || "UTC",
    })
      .formatToParts(at)
      .find((p) => p.type === "hour");
    const hour = part ? Number(part.value) : at.getUTCHours();
    if (!Number.isFinite(hour)) return at.getUTCHours();
    return hour === 24 ? 0 : hour;
  } catch {
    return at.getUTCHours();
  }
}

/** Push is suppressed inside the quiet window. */
export function isInQuietHours(
  quiet: WatchdogQuietHours | null,
  at: Date,
): boolean {
  if (!quiet) return false;
  const hour = hourInTz(quiet.timezone, at);
  const { startHour, endHour } = quiet;
  if (startHour === endHour) return false; // degenerate window = off
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour; // overnight window
}

function toMillis(value: unknown): number | null {
  if (value instanceof Timestamp) return value.toMillis();
  if (value instanceof Date) return value.getTime();
  return null;
}

async function loadThreadExcerpt(
  contactId: string,
  channel: ConversationChannel,
  nowMs: number,
): Promise<string> {
  const collection = CHANNEL_COLLECTION[channel] ?? "messages";
  const snap = await getAdminDb()
    .collection("contacts")
    .doc(contactId)
    .collection(collection)
    .orderBy("createdAt", "desc")
    .limit(THREAD_EXCERPT_MESSAGES)
    .get();
  const lines = snap.docs.reverse().map((d) => {
    const data = d.data() as {
      direction?: string;
      body?: string;
      createdAt?: unknown;
    };
    const ageMs = nowMs - (toMillis(data.createdAt) ?? nowMs);
    const ageH = Math.max(0, Math.round(ageMs / 3_600_000));
    const who = data.direction === "outbound" ? "BUSINESS" : "CUSTOMER";
    const body = (data.body ?? "").replace(/\s+/g, " ").slice(0, 300);
    return `[${who}, ${ageH}h ago] ${body}`;
  });
  return lines.join("\n") || "(no readable messages)";
}

interface SweepAccountResult {
  subAccountId: string;
  status: WatchdogRunDoc["status"];
  skippedReason: WatchdogSkippedReason | null;
  scanned: number;
  judged: number;
  flagged: number;
  tokensUsed: number;
}

/** One sub-account. Never throws; failures go in the run doc. */
async function runWatchdogForSubAccount(
  agent: WatchdogConfigDoc & { subAccountId: string },
): Promise<SweepAccountResult> {
  const db = getAdminDb();
  const subAccountId = agent.subAccountId;
  const runRef = agentRef(subAccountId).collection("runs").doc();
  const now = new Date();
  const nowMs = now.getTime();

  const base: Omit<WatchdogRunDoc, "status" | "skippedReason"> = {
    scanned: 0,
    droppedByCap: 0,
    judged: 0,
    flagged: 0,
    actions: [],
    tokensUsed: 0,
    error: null,
    startedAt: FieldValue.serverTimestamp(),
    finishedAt: FieldValue.serverTimestamp(),
  };

  const skip = async (
    reason: WatchdogSkippedReason,
  ): Promise<SweepAccountResult> => {
    await runRef.set({ ...base, status: "skipped", skippedReason: reason });
    return {
      subAccountId,
      status: "skipped",
      skippedReason: reason,
      scanned: 0,
      judged: 0,
      flagged: 0,
      tokensUsed: 0,
    };
  };

  try {
    // Guards, re-checked every run so agency changes apply within the hour.
    const saSnap = await db.doc(`subAccounts/${subAccountId}`).get();
    const sub = saSnap.exists ? (saSnap.data() as SubAccountDoc) : null;
    if (!sub || sub.labsEnabledByAgency !== true) return skip("labs_gate_off");
    if (sub.aiSuiteEnabledByAgency !== true) return skip("ai_gate_off");
    if (!aiIsConfigured()) return skip("ai_not_configured");

    // Daily token budget (UTC day).
    const today = now.toISOString().slice(0, 10);
    const tokensToday =
      agent.tokensTodayDate === today ? (agent.tokensToday ?? 0) : 0;
    const budget = agent.dailyTokenBudget ?? WATCHDOG_DEFAULT_DAILY_TOKEN_BUDGET;
    if (tokensToday >= budget) return skip("budget_exceeded");

    // Deterministic pre-filter.
    const thresholdHours =
      agent.thresholdHours ?? WATCHDOG_DEFAULT_THRESHOLD_HOURS;
    const cutoff = Timestamp.fromMillis(nowMs - thresholdHours * 3_600_000);
    const convSnap = await db
      .collection("conversations")
      .where("subAccountId", "==", subAccountId)
      .where("lastDirection", "==", "inbound")
      .where("lastMessageAt", "<=", cutoff)
      .orderBy("lastMessageAt", "asc")
      .limit(PREFILTER_FETCH_LIMIT)
      .get();

    const candidates = convSnap.docs
      .map((d) => ({ id: d.id, ...(d.data() as Omit<ConversationDoc, "id">) }))
      // Need a contact to attach a Task to, and web chat has its own operator
      // console, so only contact-backed non-web-chat threads qualify.
      .filter((c) => !!c.contactId && c.lastChannel !== "web-chat")
      .filter((c) => c.status !== "closed" && c.status !== "snoozed")
      .filter((c) => {
        // Skip if we already alerted on the current last message. A newer inbound moves
        // lastMessageAt past the stamp and re-arms it.
        const alerted = toMillis(
          (c as unknown as { watchdogAlertedAt?: unknown }).watchdogAlertedAt,
        );
        const last = toMillis(c.lastMessageAt);
        return !(alerted !== null && last !== null && alerted >= last);
      });

    const scanned = candidates.length;
    const shortlist = candidates.slice(0, WATCHDOG_MAX_JUDGMENTS_PER_RUN);
    const droppedByCap = scanned - shortlist.length;

    if (shortlist.length === 0) {
      await runRef.set({
        ...base,
        scanned,
        droppedByCap,
        status: "completed",
        skippedReason: null,
      });
      return {
        subAccountId,
        status: "completed",
        skippedReason: null,
        scanned,
        judged: 0,
        flagged: 0,
        tokensUsed: 0,
      };
    }

    // LLM judge per shortlisted conversation.
    const profile = await getAgentProfile(subAccountId).catch(() => null);
    const businessName =
      profile?.businessName?.trim() || sub.name || "the business";
    const quiet = agent.quietHours ?? null;
    const pushSuppressed = isInQuietHours(quiet, now);

    let judged = 0;
    let tokensUsed = 0;
    const actions: WatchdogRunAction[] = [];

    for (const conv of shortlist) {
      if (tokensToday + tokensUsed >= budget) break;
      // Already filtered above; this narrows the type.
      if (!conv.contactId) continue;

      const excerpt = await loadThreadExcerpt(
        conv.contactId,
        conv.lastChannel ?? "sms",
        nowMs,
      );
      const hoursWaiting = Math.max(
        1,
        Math.round((nowMs - (toMillis(conv.lastMessageAt) ?? nowMs)) / 3_600_000),
      );

      const systemPrompt = [
        `You triage unanswered inbound conversations for ${businessName}.`,
        `The customer's last message has been waiting ${hoursWaiting} hours with no reply from the business.`,
        `Decide whether a human should follow up NOW. Flag conversations where the customer asked a question, showed buying intent, raised a problem, or expects a reply. Do NOT flag pure pleasantries, closed loops ("thanks, bye"), spam, or automated notifications.`,
        agent.instructions?.trim()
          ? `Operator criteria (weigh heavily): ${agent.instructions.trim()}`
          : "",
        `Respond with ONLY this JSON, nothing else:`,
        `{"needsFollowUp": true|false, "urgency": "high"|"normal", "reason": "<one line, max 140 chars, written for the business owner>"}`,
      ]
        .filter(Boolean)
        .join("\n");

      let verdict: JudgeVerdict | null = null;
      try {
        const completion = await callAi({
          messages: [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: `Conversation with ${conv.contactName || "a contact"}:\n${excerpt}`,
            },
          ],
          maxTokens: 120,
          temperature: 0.2,
          meter: { subAccountId, source: "watchdog" },
        });
        judged++;
        tokensUsed += completion.totalTokens;
        verdict = parseVerdict(completion.text);
      } catch (err) {
        // One failed judgment shouldn't kill the sweep.
        console.warn(
          `[watchdog] judge failed sa=${subAccountId} contact=${conv.contactId}`,
          err instanceof Error ? err.message : err,
        );
        continue;
      }

      if (!verdict?.needsFollowUp) continue;

      // Act (additive only): Task, push, activity, dedupe stamp.
      const contactName = conv.contactName || "a contact";
      try {
        const task = await createTaskServerSide({
          subAccountId,
          agencyId: conv.agencyId,
          createdByUid: "ai-watchdog",
          mode: "live",
          title: `Follow up with ${contactName} — ${verdict.reason}`.slice(0, 200),
          notes: [
            `Flagged by the Inbox Follow-up Watchdog (Labs).`,
            `Waiting: ~${hoursWaiting}h since the customer's last message.`,
            `Urgency: ${verdict.urgency}.`,
            `Open the conversation: /sa/${subAccountId}/conversations/${conv.contactId}`,
          ].join("\n"),
          dueAt: now,
          contactId: conv.contactId,
          dealId: null,
          eventId: null,
        });

        if (!pushSuppressed) {
          runAfterResponse(() => sendPushForEvent({
            subAccountId,
            agencyId: conv.agencyId,
            title: `⏰ Follow-up needed: ${contactName}`,
            body: verdict.reason,
            url: `/sa/${subAccountId}/conversations/${conv.contactId}`,
            tag: `watchdog-${conv.contactId}`,
          }));
        }

        // Best-effort.
        db.collection("contacts")
          .doc(conv.contactId)
          .collection("activities")
          .add({
            type: "ai_agent_flagged",
            content: `Watchdog flagged this conversation for follow-up (${verdict.urgency}): ${verdict.reason}`,
            meta: { taskId: task.id, hoursWaiting },
            agencyId: conv.agencyId,
            subAccountId,
            createdBy: "ai-watchdog",
            createdAt: FieldValue.serverTimestamp(),
          })
          .catch((err) =>
            console.warn("[watchdog] activity write failed", err),
          );

        // One alert per inbound message; re-arms itself.
        await db.doc(`conversations/${conv.id}`).update({
          watchdogAlertedAt: FieldValue.serverTimestamp(),
        });

        actions.push({
          contactId: conv.contactId,
          contactName,
          taskId: task.id,
          reason: verdict.reason,
          urgency: verdict.urgency,
        });
      } catch (err) {
        console.error(
          `[watchdog] act failed sa=${subAccountId} contact=${conv.contactId}`,
          err,
        );
      }
    }

    await runRef.set({
      ...base,
      scanned,
      droppedByCap,
      judged,
      flagged: actions.length,
      actions,
      tokensUsed,
      status: "completed",
      skippedReason: null,
    });
    await agentRef(subAccountId).update({
      tokensTodayDate: today,
      tokensToday: tokensToday + tokensUsed,
      totalTokensUsed: FieldValue.increment(tokensUsed),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return {
      subAccountId,
      status: "completed",
      skippedReason: null,
      scanned,
      judged,
      flagged: actions.length,
      tokensUsed,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error(`[watchdog] run failed sa=${subAccountId}:`, err);
    await runRef
      .set({
        ...base,
        status: "failed",
        skippedReason: null,
        error: msg.slice(0, 500),
      })
      .catch(() => undefined);
    return {
      subAccountId,
      status: "failed",
      skippedReason: null,
      scanned: 0,
      judged: 0,
      flagged: 0,
      tokensUsed: 0,
    };
  }
}

/** Hourly cron entry. Runs enabled watchdogs one after another to keep the
 *  invocation bounded and Firestore load smooth. */
export async function runWatchdogSweep(): Promise<{
  agents: number;
  results: SweepAccountResult[];
}> {
  const snap = await getAdminDb()
    .collection(AGENTS_COLLECTION)
    .where("enabled", "==", true)
    .limit(200)
    .get();

  const results: SweepAccountResult[] = [];
  for (const doc of snap.docs) {
    const agent = {
      ...(doc.data() as WatchdogConfigDoc),
      subAccountId: doc.id,
    };
    results.push(await runWatchdogForSubAccount(agent));
  }
  return { agents: snap.size, results };
}

/** 30-day retention for run logs, from the daily cleanup cron. */
export async function sweepOldWatchdogRuns(): Promise<number> {
  const db = getAdminDb();
  const cutoff = Timestamp.fromMillis(
    Date.now() - MAX_RUNS_KEPT_DAYS * 24 * 3_600_000,
  );
  const agents = await db.collection(AGENTS_COLLECTION).limit(500).get();
  let deleted = 0;
  for (const agent of agents.docs) {
    const old = await agent.ref
      .collection("runs")
      .where("startedAt", "<", cutoff)
      .limit(200)
      .get();
    if (old.empty) continue;
    const batch = db.batch();
    for (const doc of old.docs) batch.delete(doc.ref);
    await batch.commit();
    deleted += old.size;
  }
  return deleted;
}
