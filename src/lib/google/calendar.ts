import "server-only";

import crypto from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { sendPushForEvent } from "@/lib/push/send";
import type {
  CalendarConnectionDoc,
  ExternalBusyInterval,
  GoogleCalendarPrivateDoc,
} from "@/types/calendar-sync";
import type { SubAccountDoc } from "@/types";
import { runAfterResponse } from "@/lib/server/after-response";

/**
 * Google Calendar REST wrapper (no `googleapis`, too heavy for four
 * endpoints). The only reader of `private/gcal-{uid}` token docs: every call
 * goes through getAccessToken(), which handles caching, refresh and the
 * connected -> error transition.
 *
 * Fail-open: availability callers catch {@link GoogleCalendarError} and fall
 * back to internal busy data, so a Google outage never breaks a booking page.
 * The error transition here (not callers) sends the one-time reconnect push.
 */

const OAUTH_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const OAUTH_TOKEN = "https://oauth2.googleapis.com/token";
const OAUTH_REVOKE = "https://oauth2.googleapis.com/revoke";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

/**
 * freebusy for busy checks (calendar.events doesn't cover freeBusy queries),
 * events for pushing bookings to the primary calendar, openid+email so the
 * id_token carries the account email for display.
 */
const SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.freebusy",
];

/** Data calls (freeBusy, event CRUD). */
const API_TIMEOUT_MS = 3_000;
/** Longer: token calls gate everything downstream. */
const TOKEN_TIMEOUT_MS = 8_000;

export type GoogleCalendarErrorCode =
  | "reconnect_required"
  | "api_error"
  | "timeout"
  | "not_connected"
  | "not_our_copy";

export class GoogleCalendarError extends Error {
  code: GoogleCalendarErrorCode;
  /** HTTP status from Google, when there was a response. */
  status: number | null;
  constructor(
    code: GoogleCalendarErrorCode,
    message: string,
    status: number | null = null,
  ) {
    super(message);
    this.name = "GoogleCalendarError";
    this.code = code;
    this.status = status;
  }
}

export function googleCalendarConfigured(): boolean {
  return (
    !!process.env.GOOGLE_OAUTH_CLIENT_ID &&
    !!process.env.GOOGLE_OAUTH_CLIENT_SECRET
  );
}

/**
 * Single redirect URI for the deployment (Google exact-matches the registered
 * list). Sub-account and member ride in the signed `state`. Built from
 * NEXT_PUBLIC_APP_URL, never the request origin.
 */
export function googleRedirectUri(): string | null {
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (!base) return null;
  return `${base}/api/google/callback`;
}

// CSRF state, HMAC-signed with AUTOMATIONS_TOKEN_SECRET. Carries the member's
// uid as well as the sub-account so tokens bind to the right person.

function stateSecret(): string {
  return process.env.AUTOMATIONS_TOKEN_SECRET ?? "";
}

export function signCalendarState(subAccountId: string, uid: string): string {
  const nonce = crypto.randomBytes(8).toString("hex");
  const payload = `${subAccountId}.${uid}.${nonce}`;
  const sig = crypto
    .createHmac("sha256", stateSecret())
    .update(`gcalstate:${payload}`)
    .digest("hex");
  return `${payload}.${sig}`;
}

export function verifyCalendarState(
  state: string,
): { subAccountId: string; uid: string } | null {
  const parts = state.split(".");
  if (parts.length !== 4) return null;
  const [subAccountId, uid, nonce, sig] = parts;
  const expected = crypto
    .createHmac("sha256", stateSecret())
    .update(`gcalstate:${subAccountId}.${uid}.${nonce}`)
    .digest("hex");
  if (sig.length !== expected.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      return null;
    }
  } catch {
    return null;
  }
  return { subAccountId, uid };
}

/**
 * access_type=offline + prompt=consent forces a refresh token on every connect
 * (Google otherwise only issues one on first consent), which is also how
 * reconnect heals an errored connection.
 */
export function buildGoogleOAuthUrl(opts: {
  redirectUri: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID ?? "",
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: opts.state,
  });
  return `${OAUTH_AUTHORIZE}?${params.toString()}`;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

/** Callback only. */
export async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
  email: string | null;
  grantedScopes: string[];
}> {
  const res = await fetch(OAUTH_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? "",
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }).toString(),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  const data = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !data.access_token) {
    throw new GoogleCalendarError(
      "api_error",
      `Google token exchange failed (${res.status}): ${data.error_description ?? data.error ?? "unknown"}`,
    );
  }
  if (!data.refresh_token) {
    // Shouldn't happen with prompt=consent, but without one the connection dies
    // within the hour, so refuse.
    throw new GoogleCalendarError(
      "api_error",
      "Google didn't return a refresh token. Remove the app's access at myaccount.google.com/permissions and connect again.",
    );
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAtMs: Date.now() + (data.expires_in ?? 3600) * 1000,
    email: decodeIdTokenEmail(data.id_token),
    grantedScopes: (data.scope ?? "").split(" ").filter(Boolean),
  };
}

/** Email claim from the id_token. Unverified on purpose: it came straight from Google's token endpoint and is display-only. */
function decodeIdTokenEmail(idToken: string | undefined): string | null {
  if (!idToken) return null;
  try {
    const payload = idToken.split(".")[1];
    const json = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as { email?: string };
    return json.email ?? null;
  } catch {
    return null;
  }
}

/** Best-effort revoke on disconnect. Never throws. */
export async function revokeGoogleToken(refreshToken: string): Promise<void> {
  try {
    await fetch(OAUTH_REVOKE, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refreshToken }).toString(),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch (err) {
    console.warn("[google/calendar] token revoke failed (ignored)", err);
  }
}

export function calendarPrivateRef(subAccountId: string, uid: string) {
  return getAdminDb().doc(`subAccounts/${subAccountId}/private/gcal-${uid}`);
}

export function calendarConnectionRef(subAccountId: string, uid: string) {
  return getAdminDb().doc(
    `subAccounts/${subAccountId}/calendarConnections/${uid}`,
  );
}

/**
 * Live access token, refreshed within 60s of expiry. On invalid_grant it also
 * flips the connection to error and fires the reconnect alert before throwing.
 */
export async function getAccessToken(
  subAccountId: string,
  uid: string,
): Promise<string> {
  const snap = await calendarPrivateRef(subAccountId, uid).get();
  if (!snap.exists) {
    throw new GoogleCalendarError("not_connected", "No calendar connection.");
  }
  const priv = snap.data() as GoogleCalendarPrivateDoc;
  if (!priv.refreshToken) {
    throw new GoogleCalendarError("not_connected", "No refresh token stored.");
  }

  if (
    priv.accessToken &&
    priv.accessTokenExpiresAt &&
    priv.accessTokenExpiresAt - Date.now() > 60_000
  ) {
    return priv.accessToken;
  }

  let res: Response;
  try {
    res = await fetch(OAUTH_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_OAUTH_CLIENT_ID ?? "",
        client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? "",
        refresh_token: priv.refreshToken,
        grant_type: "refresh_token",
      }).toString(),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch {
    throw new GoogleCalendarError("timeout", "Google token refresh timed out.");
  }
  const data = (await res.json().catch(() => ({}))) as TokenResponse;

  if (!res.ok || !data.access_token) {
    if (data.error === "invalid_grant") {
      // Refresh token is dead (revoked, or a Testing-mode consent screen expired it) until reconnect.
      await markConnectionError(subAccountId, uid, "reconnect_required");
      throw new GoogleCalendarError(
        "reconnect_required",
        "Google Calendar access was revoked or expired — reconnect required.",
      );
    }
    throw new GoogleCalendarError(
      "api_error",
      `Google token refresh failed (${res.status}): ${data.error ?? "unknown"}`,
    );
  }

  const expiresAtMs = Date.now() + (data.expires_in ?? 3600) * 1000;
  // Best-effort; a failed write just means another refresh next call.
  calendarPrivateRef(subAccountId, uid)
    .update({ accessToken: data.access_token, accessTokenExpiresAt: expiresAtMs })
    .catch(() => {});
  return data.access_token;
}

/**
 * Flip to `error` and push a reconnect alert once per episode. Gated on the
 * current status so repeated failures (every availability load) can't spam.
 */
export async function markConnectionError(
  subAccountId: string,
  uid: string,
  reason: string,
): Promise<void> {
  try {
    const ref = calendarConnectionRef(subAccountId, uid);
    const snap = await ref.get();
    if (!snap.exists) return;
    const conn = snap.data() as CalendarConnectionDoc;
    if (conn.status === "error") return;

    await ref.update({
      status: "error",
      errorReason: reason,
      updatedAt: FieldValue.serverTimestamp(),
    });

    const subSnap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
    const sub = subSnap.exists ? (subSnap.data() as SubAccountDoc) : null;
    if (!sub?.agencyId) return;
    const who = conn.googleEmail ?? "a team member";
    runAfterResponse(() => sendPushForEvent({
      subAccountId,
      agencyId: sub.agencyId,
      title: "Google Calendar disconnected",
      body: `${who}'s calendar sync stopped working — booking pages can't see their busy times until they reconnect.`,
      url: `/sa/${subAccountId}/dashboard/settings`,
      tag: `gcal-${subAccountId}-${uid}`,
    }));
  } catch (err) {
    console.warn(
      `[google/calendar] markConnectionError failed sa=${subAccountId} uid=${uid}`,
      err,
    );
  }
}

/**
 * Active member of the sub-account, or its agency owner (who may have no
 * member row in workspaces they didn't create). Fails closed on read errors.
 */
export async function isActiveCalendarOwner(
  subAccountId: string,
  uid: string,
): Promise<boolean> {
  try {
    const db = getAdminDb();
    const member = await db
      .doc(`subAccounts/${subAccountId}/subAccountMembers/${uid}`)
      .get();
    if (member.exists) return member.data()?.status === "active";
    const sub = await db.doc(`subAccounts/${subAccountId}`).get();
    const agencyId = sub.data()?.agencyId as string | undefined;
    if (!agencyId) return false;
    const agency = await db.doc(`agencies/${agencyId}`).get();
    return agency.data()?.ownerUid === uid;
  } catch {
    return false;
  }
}

/** Best-effort; callers' cache throttles it to ~1/min. */
export function touchLastSync(subAccountId: string, uid: string): void {
  calendarConnectionRef(subAccountId, uid)
    .update({ lastSyncAt: FieldValue.serverTimestamp() })
    .catch(() => {});
}

interface FreeBusyResponse {
  calendars?: Record<
    string,
    { busy?: Array<{ start?: string; end?: string }>; errors?: unknown[] }
  >;
}

/** Busy blocks on the primary calendar. Opaque intervals only; no titles or details leave Google. */
export async function queryFreeBusy(
  subAccountId: string,
  uid: string,
  from: Date,
  to: Date,
): Promise<ExternalBusyInterval[]> {
  const token = await getAccessToken(subAccountId, uid);
  let res: Response;
  try {
    res = await fetch(`${CALENDAR_API}/freeBusy`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        items: [{ id: "primary" }],
      }),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch {
    throw new GoogleCalendarError("timeout", "Google freeBusy timed out.");
  }
  if (res.status === 401 || res.status === 403) {
    // Rejected right after a refresh: treat as revoked.
    await markConnectionError(subAccountId, uid, "reconnect_required");
    throw new GoogleCalendarError(
      "reconnect_required",
      `Google freeBusy auth failed (${res.status}).`,
    );
  }
  if (!res.ok) {
    throw new GoogleCalendarError(
      "api_error",
      `Google freeBusy failed (${res.status}).`,
    );
  }
  const data = (await res.json().catch(() => ({}))) as FreeBusyResponse;
  const busy = data.calendars?.primary?.busy ?? [];
  const out: ExternalBusyInterval[] = [];
  for (const b of busy) {
    if (!b.start || !b.end) continue;
    const startAt = new Date(b.start);
    const endAt = new Date(b.end);
    if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime()))
      continue;
    out.push({ startAt, endAt });
  }
  touchLastSync(subAccountId, uid);
  return out;
}

interface EventResponse {
  id?: string;
  hangoutLink?: string;
  error?: { message?: string };
}

/**
 * sendUpdates=none because our own confirmation emails already go out. The
 * LeadStack event id goes in extendedProperties. With `addMeet`, Google
 * creates a Meet room on the event; the requestId is the LeadStack event id so
 * a retried insert can't mint a second room.
 */
export async function insertCalendarEvent(
  subAccountId: string,
  uid: string,
  input: {
    leadstackEventId: string;
    summary: string;
    description: string;
    location?: string;
    startAt: Date;
    endAt: Date;
    addMeet?: boolean;
  },
): Promise<{ id: string; meetUrl: string | null }> {
  const token = await getAccessToken(subAccountId, uid);
  try {
    return await postCalendarEvent(token, input, input.addMeet === true);
  } catch (err) {
    // An abort can land after Google already created the event; adopt it so
    // reschedule/cancel can still find it instead of leaving an orphan.
    if (isAbortError(err)) {
      const existing = await findCalendarEventByLeadstackId(
        token,
        input.leadstackEventId,
      );
      if (existing) return existing;
      throw new GoogleCalendarError("timeout", "Google event insert timed out.");
    }
    // Accounts where Meet is off (some Workspace domains) reject the
    // conference request; the booking still belongs on the calendar.
    if (
      input.addMeet &&
      err instanceof GoogleCalendarError &&
      err.status === 400
    ) {
      return postCalendarEvent(token, input, false);
    }
    throw err;
  }
}

function isAbortError(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

async function findCalendarEventByLeadstackId(
  token: string,
  leadstackEventId: string,
): Promise<{ id: string; meetUrl: string | null } | null> {
  try {
    const params = new URLSearchParams({
      privateExtendedProperty: `leadstackEventId=${leadstackEventId}`,
      maxResults: "1",
    });
    const res = await fetch(
      `${CALENDAR_API}/calendars/primary/events?${params.toString()}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      },
    );
    if (!res.ok) return null;
    const data = (await res.json().catch(() => ({}))) as {
      items?: EventResponse[];
    };
    const hit = data.items?.[0];
    return hit?.id ? { id: hit.id, meetUrl: hit.hangoutLink ?? null } : null;
  } catch {
    return null;
  }
}

async function postCalendarEvent(
  token: string,
  input: {
    leadstackEventId: string;
    summary: string;
    description: string;
    location?: string;
    startAt: Date;
    endAt: Date;
  },
  addMeet: boolean,
): Promise<{ id: string; meetUrl: string | null }> {
  const params = new URLSearchParams({ sendUpdates: "none" });
  if (addMeet) params.set("conferenceDataVersion", "1");
  const res = await fetch(
    `${CALENDAR_API}/calendars/primary/events?${params.toString()}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        summary: input.summary,
        description: input.description,
        ...(input.location ? { location: input.location } : {}),
        start: { dateTime: input.startAt.toISOString() },
        end: { dateTime: input.endAt.toISOString() },
        extendedProperties: {
          private: { leadstackEventId: input.leadstackEventId },
        },
        ...(addMeet
          ? {
              conferenceData: {
                createRequest: {
                  requestId: input.leadstackEventId,
                  conferenceSolutionKey: { type: "hangoutsMeet" },
                },
              },
            }
          : {}),
      }),
      // Room creation is slower than a plain insert.
      signal: AbortSignal.timeout(addMeet ? 5_000 : API_TIMEOUT_MS),
    },
  );
  const data = (await res.json().catch(() => ({}))) as EventResponse;
  if (!res.ok || !data.id) {
    throw new GoogleCalendarError(
      "api_error",
      `Google event insert failed (${res.status}): ${data.error?.message ?? "unknown"}`,
      res.status,
    );
  }
  return { id: data.id, meetUrl: data.hangoutLink ?? null };
}

/**
 * Patch and delete act with the owner's own token, and the Google id comes
 * from an event doc, so only touch an event this CRM made for that doc.
 * False means Google no longer has it.
 */
async function isOurCopy(
  token: string,
  googleEventId: string,
  leadstackEventId: string,
): Promise<boolean> {
  const params = new URLSearchParams({
    fields: "status,extendedProperties(private)",
  });
  const res = await fetch(
    `${CALENDAR_API}/calendars/primary/events/${encodeURIComponent(googleEventId)}?${params}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    },
  );
  if (res.status === 404 || res.status === 410) return false;
  if (!res.ok) {
    throw new GoogleCalendarError(
      "api_error",
      `Google event lookup failed (${res.status}).`,
      res.status,
    );
  }
  const data = (await res.json().catch(() => ({}))) as {
    status?: string;
    extendedProperties?: { private?: Record<string, string> };
  };
  // A deleted event can still be fetched, as "cancelled" and without its properties.
  if (data.status === "cancelled") return false;
  if (data.extendedProperties?.private?.leadstackEventId !== leadstackEventId) {
    throw new GoogleCalendarError(
      "not_our_copy",
      "Google event was not created for this CRM event.",
    );
  }
  return true;
}

/** Reschedule or edit. Only the fields passed are changed. */
export async function patchCalendarEvent(
  subAccountId: string,
  uid: string,
  googleEventId: string,
  leadstackEventId: string,
  input: {
    startAt: Date;
    endAt: Date;
    summary?: string;
    description?: string;
    location?: string;
  },
): Promise<void> {
  const token = await getAccessToken(subAccountId, uid);
  if (!(await isOurCopy(token, googleEventId, leadstackEventId))) return;
  const res = await fetch(
    `${CALENDAR_API}/calendars/primary/events/${encodeURIComponent(googleEventId)}?sendUpdates=none`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        start: { dateTime: input.startAt.toISOString() },
        end: { dateTime: input.endAt.toISOString() },
        ...(input.summary !== undefined ? { summary: input.summary } : {}),
        ...(input.description !== undefined
          ? { description: input.description }
          : {}),
        ...(input.location !== undefined ? { location: input.location } : {}),
      }),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    },
  );
  if (res.status === 404 || res.status === 410) {
    // Host deleted our copy from their calendar.
    return;
  }
  if (!res.ok) {
    throw new GoogleCalendarError(
      "api_error",
      `Google event patch failed (${res.status}).`,
    );
  }
}

/** Cancel. 404/410 means already gone, treated as success. */
export async function deleteCalendarEvent(
  subAccountId: string,
  uid: string,
  googleEventId: string,
  leadstackEventId: string,
): Promise<void> {
  const token = await getAccessToken(subAccountId, uid);
  if (!(await isOurCopy(token, googleEventId, leadstackEventId))) return;
  const res = await fetch(
    `${CALENDAR_API}/calendars/primary/events/${encodeURIComponent(googleEventId)}?sendUpdates=none`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    },
  );
  if (res.ok || res.status === 404 || res.status === 410) return;
  throw new GoogleCalendarError(
    "api_error",
    `Google event delete failed (${res.status}).`,
  );
}
