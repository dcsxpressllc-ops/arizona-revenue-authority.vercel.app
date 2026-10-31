import "server-only";

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { postSlackMessage } from "@/lib/slack/client";
import { slackTestMessage } from "@/lib/slack/format";
import {
  DEFAULT_SLACK_EVENTS,
  SLACK_WEBHOOK_URL_RE,
  type SlackConfigResponse,
  type SlackMeta,
  type SlackPrivateDoc,
} from "@/types/slack";
import type { WebhookEventType } from "@/types/webhooks";
import { WEBHOOK_EVENT_CATEGORIES } from "@/lib/webhooks/event-categories";
import type { SubAccountDoc } from "@/types";

/**
 * The only reader and writer of `subAccounts/{id}/private/slack`. The card
 * and the assistant only ever see `slackMeta`.
 */

export class SlackError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

function privateRef(subAccountId: string) {
  return getAdminDb().doc(`subAccounts/${subAccountId}/private/slack`);
}
function subRef(subAccountId: string) {
  return getAdminDb().doc(`subAccounts/${subAccountId}`);
}

export function appUrl(): string | null {
  const raw = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (!raw || !/^https?:\/\//i.test(raw)) return null;
  return raw.replace(/\/$/, "");
}

function tsToIso(v: unknown): string | null {
  if (v instanceof Timestamp) return v.toDate().toISOString();
  if (v instanceof Date) return v.toISOString();
  return null;
}

export function serializeSlackMeta(
  meta: Partial<SlackMeta> | null | undefined,
): SlackConfigResponse {
  return {
    connected: meta?.connected === true,
    channelLabel: meta?.channelLabel ?? null,
    urlTail: meta?.urlTail ?? null,
    events: Array.isArray(meta?.events) ? meta.events : [],
    lastSentAt: tsToIso(meta?.lastSentAt),
    lastError: meta?.lastError ?? null,
    needsReconnect: meta?.needsReconnect === true,
  };
}

export async function getSlackConfig(
  subAccountId: string,
): Promise<SlackConfigResponse> {
  const snap = await subRef(subAccountId).get();
  return serializeSlackMeta(
    (snap.data() as Partial<SubAccountDoc> | undefined)?.slackMeta,
  );
}

/** Only events the picker can show; anything without a category is dropped. */
export function sanitizeSlackEvents(raw: unknown): WebhookEventType[] {
  if (!Array.isArray(raw)) return [];
  const known = new Set<string>(
    WEBHOOK_EVENT_CATEGORIES.flatMap((c) => c.events),
  );
  const out: WebhookEventType[] = [];
  for (const v of raw) {
    if (typeof v === "string" && known.has(v) && !out.includes(v as WebhookEventType)) {
      out.push(v as WebhookEventType);
    }
  }
  return out;
}

/** Validates the URL, proves it with a test post, then stores both docs. */
export async function connectSlack(opts: {
  subAccountId: string;
  uid: string;
  webhookUrl: string;
  /** Omitted = keep the existing label on a reconnect. */
  channelLabel?: string | null;
  events?: WebhookEventType[];
}): Promise<SlackConfigResponse> {
  const url = opts.webhookUrl.trim();
  if (!SLACK_WEBHOOK_URL_RE.test(url)) {
    throw new SlackError(
      "That doesn't look like a Slack Incoming Webhook URL (it starts with https://hooks.slack.com/services/).",
      400,
    );
  }
  const test = await postSlackMessage(url, slackTestMessage(appUrl(), opts.subAccountId));
  if (!test.ok) {
    throw new SlackError(test.error ?? "Slack rejected the test message.", 502);
  }

  const existing = (await subRef(opts.subAccountId).get()).data() as
    | Partial<SubAccountDoc>
    | undefined;
  // Explicit list wins; a reconnect keeps whatever was ticked (even nothing).
  const events =
    opts.events ??
    (existing?.slackMeta?.connected && Array.isArray(existing.slackMeta.events)
      ? existing.slackMeta.events
      : DEFAULT_SLACK_EVENTS);

  const privateDoc: SlackPrivateDoc = {
    webhookUrl: url,
    connectedByUid: opts.uid,
    connectedAt: FieldValue.serverTimestamp(),
  };
  const meta: SlackMeta = {
    connected: true,
    channelLabel:
      opts.channelLabel === undefined
        ? existing?.slackMeta?.channelLabel ?? null
        : opts.channelLabel?.trim().slice(0, 60) || null,
    urlTail: url.slice(-6),
    events,
    lastSentAt: FieldValue.serverTimestamp(),
    lastError: null,
    needsReconnect: false,
    updatedAt: FieldValue.serverTimestamp(),
  };
  const batch = getAdminDb().batch();
  batch.set(privateRef(opts.subAccountId), privateDoc);
  batch.set(
    subRef(opts.subAccountId),
    { slackMeta: meta, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
  await batch.commit();
  return getSlackConfig(opts.subAccountId);
}

export async function updateSlackEvents(
  subAccountId: string,
  events: WebhookEventType[],
): Promise<SlackConfigResponse> {
  const snap = await subRef(subAccountId).get();
  const meta = (snap.data() as Partial<SubAccountDoc> | undefined)?.slackMeta;
  if (!meta?.connected) {
    throw new SlackError("Connect a Slack channel first.", 400);
  }
  await subRef(subAccountId).update({
    "slackMeta.events": events,
    "slackMeta.updatedAt": FieldValue.serverTimestamp(),
  });
  return getSlackConfig(subAccountId);
}

export async function sendSlackTest(
  subAccountId: string,
): Promise<SlackConfigResponse> {
  const priv = (await privateRef(subAccountId).get()).data() as
    | SlackPrivateDoc
    | undefined;
  if (!priv?.webhookUrl) {
    throw new SlackError("Connect a Slack channel first.", 400);
  }
  const result = await postSlackMessage(
    priv.webhookUrl,
    slackTestMessage(appUrl(), subAccountId),
  );
  await recordSlackResult(subAccountId, result);
  if (!result.ok) {
    throw new SlackError(result.error ?? "Slack rejected the test message.", 502);
  }
  return getSlackConfig(subAccountId);
}

export async function disconnectSlack(subAccountId: string): Promise<void> {
  const batch = getAdminDb().batch();
  batch.delete(privateRef(subAccountId));
  batch.set(
    subRef(subAccountId),
    {
      slackMeta: {
        connected: false,
        channelLabel: null,
        urlTail: null,
        events: [],
        lastSentAt: null,
        lastError: null,
        needsReconnect: false,
        updatedAt: FieldValue.serverTimestamp(),
      } satisfies SlackMeta,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  await batch.commit();
}

/** Read the hook for a post; null when not connected or marked revoked. */
export async function loadSlackHook(
  subAccountId: string,
): Promise<{ webhookUrl: string; events: WebhookEventType[] } | null> {
  const subSnap = await subRef(subAccountId).get();
  const meta = (subSnap.data() as Partial<SubAccountDoc> | undefined)?.slackMeta;
  if (!meta?.connected || meta.needsReconnect) return null;
  const priv = (await privateRef(subAccountId).get()).data() as
    | SlackPrivateDoc
    | undefined;
  if (!priv?.webhookUrl) return null;
  return {
    webhookUrl: priv.webhookUrl,
    events: Array.isArray(meta.events) ? meta.events : [],
  };
}

const STAMP_MIN_INTERVAL_MS = 60_000;
const lastStamp = new Map<string, { at: number; ok: boolean }>();

/**
 * Best-effort status stamp. The sub-account doc is hot (every member's
 * onSnapshot), so successes are stamped at most once a minute per instance
 * unless they clear an error; failures always land.
 */
export async function recordSlackResult(
  subAccountId: string,
  result: { ok: boolean; error: string | null; revoked: boolean },
): Promise<void> {
  const prev = lastStamp.get(subAccountId);
  if (
    result.ok &&
    prev?.ok &&
    Date.now() - prev.at < STAMP_MIN_INTERVAL_MS
  ) {
    return;
  }
  lastStamp.set(subAccountId, { at: Date.now(), ok: result.ok });
  try {
    await subRef(subAccountId).update(
      result.ok
        ? {
            "slackMeta.lastSentAt": FieldValue.serverTimestamp(),
            "slackMeta.lastError": null,
            "slackMeta.needsReconnect": false,
          }
        : {
            "slackMeta.lastError": (result.error ?? "Post failed").slice(0, 300),
            // Only a revoked hook flips the card; a transient failure must not
            // clear a reconnect flag another instance just set.
            ...(result.revoked ? { "slackMeta.needsReconnect": true } : {}),
          },
    );
  } catch (err) {
    console.warn("[slack] status stamp failed", err);
  }
}
