import "server-only";

import crypto from "node:crypto";

/**
 * Messenger + Instagram DM wrapper. Inert unless the deployment has a Meta app
 * (META_APP_ID + META_APP_SECRET) and the agency gate `metaInboxEnabledByAgency`
 * is on. Like lib/comms/twilio.ts: helpers and Graph API calls, no Firestore
 * writes. The Graph version is pinned so a Meta default bump can't change behaviour.
 */

const GRAPH_VERSION = "v21.0";
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

/**
 * `pages_messaging` and `instagram_manage_messages` need Meta App Review; until
 * then only the app's own admins/testers can grant them.
 */
const BASE_SCOPES = [
  "pages_show_list",
  "pages_messaging",
  "pages_manage_metadata",
  "pages_read_engagement",
  "instagram_basic",
  "instagram_manage_messages",
  "business_management",
];

/** For Social Planner publishing. */
const PUBLISH_SCOPES = ["pages_manage_posts", "instagram_content_publish"];

/**
 * Scope string for the one shared Meta connection (inbox and Social Planner use
 * the same Page token). Always the base scopes, plus publish scopes when the
 * Social Planner gate is on. Granted scopes are recorded as capabilities at
 * connect time, so a declined permission can't leave the UI claiming it.
 */
export function metaScopeList(opts: { publish: boolean }): string {
  return [...BASE_SCOPES, ...(opts.publish ? PUBLISH_SCOPES : [])].join(",");
}

/** Inbox-only default for buildMetaOAuthUrl. */
const OAUTH_SCOPES = metaScopeList({ publish: false });

const SUBSCRIBED_FIELDS = "messages,messaging_postbacks,message_reactions";

/**
 * One fixed redirect URI for the whole deployment: Meta does a strict exact
 * match against the registered list, so the sub-account travels in the signed
 * `state` instead. Built from NEXT_PUBLIC_APP_URL (not the request origin) so
 * it's identical across hosts and between authorize and token exchange. null
 * when the env var is unset, so callers fail loudly.
 */
export function metaRedirectUri(): string | null {
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (!base) return null;
  return `${base}/api/meta/callback`;
}

/** Gate every connect/send on this. */
export function metaAppConfigured(): boolean {
  return !!process.env.META_APP_ID && !!process.env.META_APP_SECRET;
}

/** Echoed by Meta during the webhook GET handshake. */
export function metaWebhookVerifyToken(): string | null {
  return process.env.META_WEBHOOK_VERIFY_TOKEN || null;
}

/** Defaults to the inbox scopes; the connect route passes `metaScopeList({ publish })`. */
export function buildMetaOAuthUrl(opts: {
  redirectUri: string;
  state: string;
  scope?: string;
}): string {
  const params = new URLSearchParams({
    client_id: process.env.META_APP_ID ?? "",
    redirect_uri: opts.redirectUri,
    state: opts.state,
    scope: opts.scope ?? OAUTH_SCOPES,
    response_type: "code",
  });
  return `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${params.toString()}`;
}

// CSRF state, HMAC-signed with AUTOMATIONS_TOKEN_SECRET so the callback can
// trust it (and the sub-account it names) without storing anything.

function stateSecret(): string {
  return process.env.AUTOMATIONS_TOKEN_SECRET ?? "";
}

export function signMetaState(subAccountId: string, nonce: string): string {
  const payload = `${subAccountId}.${nonce}`;
  const sig = crypto
    .createHmac("sha256", stateSecret())
    .update(`metastate:${payload}`)
    .digest("hex");
  return `${payload}.${sig}`;
}

export function verifyMetaState(
  state: string,
): { subAccountId: string } | null {
  const parts = state.split(".");
  if (parts.length !== 3) return null;
  const [subAccountId, nonce, sig] = parts;
  const expected = crypto
    .createHmac("sha256", stateSecret())
    .update(`metastate:${subAccountId}.${nonce}`)
    .digest("hex");
  if (sig.length !== expected.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      return null;
    }
  } catch {
    return null;
  }
  return { subAccountId };
}

/** X-Hub-Signature-256: `sha256=` HMAC of the raw body with the app secret. False when no secret is configured. */
export function verifyMetaSignature(
  rawBody: string,
  header: string | null,
): boolean {
  const secret = process.env.META_APP_SECRET ?? "";
  if (!header || !secret) return false;
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  if (header.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
  } catch {
    return false;
  }
}

// Graph API calls (connect flow + inbound enrichment)

interface TokenResponse {
  access_token?: string;
}

/** OAuth `code` to user access token. */
export async function exchangeCodeForUserToken(
  code: string,
  redirectUri: string,
): Promise<string> {
  const params = new URLSearchParams({
    client_id: process.env.META_APP_ID ?? "",
    client_secret: process.env.META_APP_SECRET ?? "",
    redirect_uri: redirectUri,
    code,
  });
  const res = await fetch(`${GRAPH}/oauth/access_token?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`Meta token exchange failed (${res.status})`);
  }
  const data = (await res.json()) as TokenResponse;
  if (!data.access_token) throw new Error("Meta token exchange: no token");
  return data.access_token;
}

export interface MetaPage {
  id: string;
  name: string;
  accessToken: string;
  instagramBusinessAccountId: string | null;
  instagramUsername: string | null;
}

interface PagesResponse {
  data?: Array<{
    id: string;
    name?: string;
    access_token?: string;
    instagram_business_account?: { id?: string; username?: string };
  }>;
}

/** Pages the user manages, with any linked IG account. */
export async function listMetaPages(userToken: string): Promise<MetaPage[]> {
  const fields =
    "id,name,access_token,instagram_business_account{id,username}";
  const res = await fetch(
    `${GRAPH}/me/accounts?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(userToken)}`,
  );
  if (!res.ok) {
    throw new Error(`Meta pages fetch failed (${res.status})`);
  }
  const data = (await res.json()) as PagesResponse;
  return (data.data ?? []).map((p) => ({
    id: p.id,
    name: p.name ?? "Facebook Page",
    accessToken: p.access_token ?? "",
    instagramBusinessAccountId: p.instagram_business_account?.id ?? null,
    instagramUsername: p.instagram_business_account?.username ?? null,
  }));
}

interface PermissionsResponse {
  data?: Array<{ permission?: string; status?: string }>;
}

/** Permissions actually granted (not declined). Empty set on failure, so the caller assumes no capabilities. */
export async function getGrantedScopes(userToken: string): Promise<Set<string>> {
  try {
    const res = await fetch(
      `${GRAPH}/me/permissions?access_token=${encodeURIComponent(userToken)}`,
    );
    if (!res.ok) return new Set();
    const data = (await res.json()) as PermissionsResponse;
    const granted = new Set<string>();
    for (const row of data.data ?? []) {
      if (row.permission && row.status === "granted") granted.add(row.permission);
    }
    return granted;
  } catch {
    return new Set();
  }
}

export async function subscribePageToWebhook(
  pageId: string,
  pageAccessToken: string,
): Promise<void> {
  const params = new URLSearchParams({
    subscribed_fields: SUBSCRIBED_FIELDS,
    access_token: pageAccessToken,
  });
  const res = await fetch(
    `${GRAPH}/${pageId}/subscribed_apps?${params.toString()}`,
    { method: "POST" },
  );
  if (!res.ok) {
    throw new Error(`Meta page subscribe failed (${res.status})`);
  }
}

/** Best-effort, on disconnect. */
export async function unsubscribePageFromWebhook(
  pageId: string,
  pageAccessToken: string,
): Promise<void> {
  const params = new URLSearchParams({ access_token: pageAccessToken });
  const res = await fetch(
    `${GRAPH}/${pageId}/subscribed_apps?${params.toString()}`,
    { method: "DELETE" },
  );
  if (!res.ok) {
    throw new Error(`Meta page unsubscribe failed (${res.status})`);
  }
}

/** Meta's error envelope on a failed Graph call. */
export interface MetaApiError {
  message?: string;
  code?: number;
  error_subcode?: number;
  type?: string;
}

interface SendResponse {
  message_id?: string;
  error?: MetaApiError;
}

/**
 * Turn raw Meta send errors into something an operator can act on. Pre-review
 * apps mostly hit permission errors (10/200) and "user not reachable" (100), so
 * we explain the fix and point at Settings > Messaging. This never bypasses
 * Meta's gate; it just makes the failure readable.
 */
export function describeMetaSendError(
  error: MetaApiError | undefined,
  channel: "messenger" | "instagram",
): string {
  const platform = channel === "instagram" ? "Instagram" : "Messenger";
  const ig = channel === "instagram";
  const permScope = ig ? "instagram_manage_messages" : "pages_messaging";

  switch (error?.code) {
    case 3:
      return `Meta reports the app lacks the ${platform} messaging capability. ${ig ? `Check the Meta app has Instagram messaging enabled (App Dashboard → Messenger → Instagram settings) and that "${permScope}" is granted — then Reconnect under Settings → Messaging.` : `Check the "${permScope}" permission is granted, then Reconnect under Settings → Messaging.`}`;
    case 190:
      return `The ${platform} connection has expired. Reconnect the Facebook Page under Settings → Messaging.`;
    case 10:
    case 200:
      return `${platform} messaging isn't authorized yet. In Meta Development mode it only works for people added as Testers on your Meta app, and the "${permScope}" permission must be granted. Sending to the general public requires Meta App Review. See "Testing & troubleshooting" under Settings → Messaging.`;
    case 100:
      return `Meta couldn't deliver this ${platform} message. In Development mode you can only message people who are Testers on your Meta app, and they must have messaged you within the last 24 hours.${ig ? ' Also confirm the Instagram account has "Allow access to messages" turned on.' : ""} See "Testing & troubleshooting" under Settings → Messaging.`;
    case 551:
      return `This ${platform} user isn't reachable right now — they may have blocked messages, or the 24-hour reply window has closed.`;
    case 4:
    case 613:
      return `${platform} is rate-limiting messages right now. Wait a minute and try again.`;
    default:
      return error?.message
        ? `${platform} send failed: ${error.message}`
        : `${platform} send failed.`;
  }
}

/**
 * Send a text on Messenger or Instagram. Both go through the Page node
 * (`{page-id}/messages`) with the Page token; the recipient's scoped id does
 * the routing. Using the IG business-account id as the node fails with "(#3)
 * Application does not have the capability", since that node needs an
 * Instagram-Login token on graph.instagram.com. `messaging_type: "RESPONSE"` is
 * the standard in-window reply. Returns the message id; throws Meta's error text.
 */
export async function sendMetaMessage(opts: {
  channel: "messenger" | "instagram";
  fromNodeId: string;
  recipientId: string;
  text: string;
  pageAccessToken: string;
}): Promise<string> {
  const res = await fetch(
    `${GRAPH}/${opts.fromNodeId}/messages?access_token=${encodeURIComponent(opts.pageAccessToken)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_type: "RESPONSE",
        recipient: { id: opts.recipientId },
        message: { text: opts.text },
      }),
    },
  );
  const data = (await res.json().catch(() => ({}))) as SendResponse;
  if (!res.ok || data.error || !data.message_id) {
    // Raw error goes to server logs; the operator gets the mapped message.
    console.warn(
      `[meta/send] ${opts.channel} send failed status=${res.status}`,
      data.error,
    );
    throw new Error(describeMetaSendError(data.error, opts.channel));
  }
  return data.message_id;
}

interface ProfileResponse {
  name?: string;
  username?: string;
}

/** Display name by page-scoped id. null on any failure so inbound handling never blocks. */
export async function getMetaUserName(
  userId: string,
  pageAccessToken: string,
): Promise<string | null> {
  try {
    const res = await fetch(
      `${GRAPH}/${userId}?fields=name,username&access_token=${encodeURIComponent(pageAccessToken)}`,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as ProfileResponse;
    return data.name || data.username || null;
  } catch {
    return null;
  }
}

// Social Planner publishing (Facebook Page + Instagram Business)

interface PublishResponse {
  id?: string;
  post_id?: string;
  error?: { message?: string; code?: number };
}

/**
 * Post to a Page feed. With an image we POST to `/photos` (Meta fetches the
 * public URL); text-only goes to `/feed`. Needs pages_manage_posts. Returns the
 * object id; throws Meta's error text.
 */
export async function publishToFacebookPage(opts: {
  pageId: string;
  pageAccessToken: string;
  message: string;
  imageUrl?: string | null;
}): Promise<{ id: string }> {
  const useImage = !!opts.imageUrl;
  const endpoint = useImage
    ? `${GRAPH}/${opts.pageId}/photos`
    : `${GRAPH}/${opts.pageId}/feed`;
  const body = new URLSearchParams({ access_token: opts.pageAccessToken });
  if (useImage) {
    body.set("url", opts.imageUrl as string);
    if (opts.message) body.set("caption", opts.message);
  } else {
    body.set("message", opts.message);
  }
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = (await res.json().catch(() => ({}))) as PublishResponse;
  const id = data.post_id ?? data.id;
  if (!res.ok || data.error || !id) {
    throw new Error(
      data.error?.message ?? `Facebook publish failed (${res.status})`,
    );
  }
  return { id };
}

interface ContainerStatusResponse {
  status_code?: string;
  error?: { message?: string };
}

/**
 * IG containers process asynchronously; calling media_publish before
 * status_code is FINISHED fails with "Media ID is not available" (small images
 * often hide the race, 1080x1350 shows it reliably). Polls with backoff, treats
 * ERROR/EXPIRED as failures, and gives up after ~4 minutes, inside the step
 * route's maxDuration and Meta's 5-minute guidance. Status-fetch blips are
 * ignored. Runs inside the QStash callback, so waiting costs the user nothing.
 */
async function waitForInstagramContainerReady(
  containerId: string,
  pageAccessToken: string,
): Promise<void> {
  const deadline = Date.now() + 240_000;
  let delayMs = 2_000;
  for (;;) {
    let statusCode: string | undefined;
    try {
      const res = await fetch(
        `${GRAPH}/${containerId}?fields=status_code&access_token=${encodeURIComponent(pageAccessToken)}`,
      );
      const data = (await res.json().catch(() => ({}))) as ContainerStatusResponse;
      statusCode = data.status_code;
    } catch {
      // Network blip; retry until the deadline.
    }
    if (statusCode === "FINISHED" || statusCode === "PUBLISHED") return;
    if (statusCode === "ERROR" || statusCode === "EXPIRED") {
      throw new Error(
        `Instagram couldn't process the image (container ${statusCode}). Check the image URL is public and a supported format/size.`,
      );
    }
    if (Date.now() + delayMs > deadline) {
      throw new Error(
        "Instagram is still processing the image — it didn't become ready in time. Reschedule the post to retry.",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    delayMs = Math.min(delayMs + 1_000, 5_000);
  }
}

/**
 * Single-image IG post: create a container from the public `imageUrl`, wait
 * for processing, then publish. IG has no binary upload, so the image must be a
 * public https URL. Authed with the Page token; needs instagram_content_publish.
 * Returns the media id; throws Meta's error text.
 */
export async function publishToInstagram(opts: {
  igUserId: string;
  pageAccessToken: string;
  caption: string;
  imageUrl: string;
}): Promise<{ id: string }> {
  // 1. Create the container.
  const createBody = new URLSearchParams({
    image_url: opts.imageUrl,
    access_token: opts.pageAccessToken,
  });
  if (opts.caption) createBody.set("caption", opts.caption);
  const createRes = await fetch(`${GRAPH}/${opts.igUserId}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: createBody.toString(),
  });
  const createData = (await createRes.json().catch(() => ({}))) as PublishResponse;
  if (!createRes.ok || createData.error || !createData.id) {
    throw new Error(
      createData.error?.message ??
        `Instagram container create failed (${createRes.status})`,
    );
  }

  // 2. Wait for processing, or media_publish fails with "Media ID is not available".
  await waitForInstagramContainerReady(createData.id, opts.pageAccessToken);

  // 3. Publish.
  const publishBody = new URLSearchParams({
    creation_id: createData.id,
    access_token: opts.pageAccessToken,
  });
  const publishRes = await fetch(`${GRAPH}/${opts.igUserId}/media_publish`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: publishBody.toString(),
  });
  const publishData = (await publishRes.json().catch(() => ({}))) as PublishResponse;
  if (!publishRes.ok || publishData.error || !publishData.id) {
    throw new Error(
      publishData.error?.message ??
        `Instagram publish failed (${publishRes.status})`,
    );
  }
  return { id: publishData.id };
}
