import "server-only";

import { Client, Receiver } from "@upstash/qstash";

/**
 * Thin QStash wrapper: publishCallback() schedules a POST to an app path, and
 * verifyQStashSignature() checks inbound callbacks.
 *
 * Without QSTASH_TOKEN, publishCallback returns null and callers warn, so local
 * dev works (scheduled work just doesn't fire).
 */

let _client: Client | null = null;
let _receiver: Receiver | null = null;

function getClient(): Client | null {
  if (!process.env.QSTASH_TOKEN) return null;
  if (!_client) {
    // QSTASH_URL is region-specific and the SDK default may not match the token's region.
    const baseUrl = process.env.QSTASH_URL;
    _client = new Client({
      token: process.env.QSTASH_TOKEN,
      ...(baseUrl ? { baseUrl } : {}),
    });
  }
  return _client;
}

function getReceiver(): Receiver | null {
  const current = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const next = process.env.QSTASH_NEXT_SIGNING_KEY;
  if (!current || !next) return null;
  if (!_receiver) {
    _receiver = new Receiver({
      currentSigningKey: current,
      nextSigningKey: next,
    });
  }
  return _receiver;
}

export function qstashIsConfigured(): boolean {
  return !!getClient() && !!getReceiver();
}

interface PublishCallbackInput {
  /** App path, e.g. "/api/automations/step"; appended to NEXT_PUBLIC_APP_URL. */
  pathname: string;
  body: Record<string, unknown>;
  /** 0 = fire immediately. */
  delaySeconds: number;
  /** Underscores only, no colons. Reschedules pass a nonce-suffixed id. */
  deduplicationId: string;
}

interface PublishCallbackResult {
  messageId: string;
}

/**
 * Schedule a POST to any app path. Used by workflows, broadcasts, the social
 * planner and the website poll loop. null if QStash isn't configured or the
 * publish failed; callers usually mark the work item failed.
 */
export async function publishCallback(
  input: PublishCallbackInput,
): Promise<PublishCallbackResult | null> {
  const client = getClient();
  if (!client) return null;

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (!baseUrl) {
    console.error("[qstash] NEXT_PUBLIC_APP_URL not set");
    return null;
  }

  try {
    const res = await client.publishJSON({
      url: `${baseUrl}${input.pathname}`,
      body: input.body,
      delay: Math.max(0, Math.floor(input.delaySeconds)),
      deduplicationId: input.deduplicationId,
    });
    return { messageId: res.messageId };
  } catch (err) {
    console.error("[qstash] publishCallback failed", err);
    return null;
  }
}

interface PublishSocialPostInput {
  postId: string;
  subAccountId: string;
  /** 0 = publish immediately. */
  delaySeconds: number;
}

/**
 * Schedule a Social Planner post. The `social_<postId>` dedup id can't collide
 * with automation/broadcast ids, and re-publishing the same post collapses
 * inside the dedup window.
 */
export async function publishSocialPost(
  input: PublishSocialPostInput,
): Promise<PublishCallbackResult | null> {
  return publishCallback({
    pathname: "/api/social/publish/step",
    body: { postId: input.postId, subAccountId: input.subAccountId },
    delaySeconds: input.delaySeconds,
    deduplicationId: `social_${input.postId}`,
  });
}

export async function verifyQStashSignature(
  signature: string,
  body: string,
): Promise<boolean> {
  const receiver = getReceiver();
  if (!receiver) return false;
  try {
    return await receiver.verify({ signature, body });
  } catch {
    return false;
  }
}
