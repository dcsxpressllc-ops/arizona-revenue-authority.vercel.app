import "server-only";

import crypto from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  calendarConnectionRef,
  calendarPrivateRef,
  getAccessToken,
  GoogleCalendarError,
  isActiveCalendarOwner,
  markConnectionError,
  revokeGoogleToken,
} from "@/lib/google/calendar";
import type {
  CalendarConnectionDoc,
  CalendarImportMode,
} from "@/types/calendar-sync";
import type { SubAccountDoc } from "@/types";

/**
 * Google Calendar import: a member's own Google events shown on the CRM
 * calendar. Two keys: the workspace allows it (calendarImportAllowed) and the
 * member opts in for their own calendar (importMode). Imported docs are
 * read-only (rules) and minimal: never descriptions, attendee lists,
 * conference links or attachments.
 *
 * Imported docs use their own fields (importOwnerUid, importedGoogleEventId),
 * never googleCalendarEventId/OwnerUid, so the booking push/move/delete code
 * can't reach a member's real Google events.
 */

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const LIST_TIMEOUT_MS = 8_000;
const WINDOW_BACK_MS = 30 * 86_400_000;
const WINDOW_AHEAD_MS = 180 * 86_400_000;
/** A full reconcile at least this often catches drift and the sliding window. */
const FULL_SYNC_EVERY_MS = 24 * 3_600_000;
const INCREMENTAL_OVERLAP_MS = 5 * 60_000;
const MAX_EVENTS_PER_MEMBER = 2_000;
const MAX_PAGES = 20;
const BATCH_SIZE = 400;
/** Stop paging this long before the deadline so writes still fit. */
const DEADLINE_MARGIN_MS = 8_000;
export const IMPORT_SOURCE = "google" as const;
const IMPORT_CREATOR = "google-import";
const BUSY_TITLE = "Busy";

/** Event types that aren't appointments (Google's own classification). */
const SKIPPED_EVENT_TYPES = new Set(["workingLocation", "birthday", "fromGmail"]);
/** 403 reasons that mean "slow down", not "access revoked". */
const RATE_LIMIT_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "quotaExceeded",
  "dailyLimitExceeded",
]);

export function importModeOn(mode: CalendarImportMode | undefined | null): boolean {
  return mode === "busy" || mode === "details";
}

export function workspaceAllowsImport(
  sub: Pick<SubAccountDoc, "calendarImportAllowed"> | null | undefined,
): boolean {
  return sub?.calendarImportAllowed === true;
}

/**
 * Deterministic, so re-running a sync never duplicates. Scoped to the
 * workspace because one member can import the same calendar into several.
 */
export function importedEventDocId(
  subAccountId: string,
  uid: string,
  googleEventId: string,
): string {
  const h = crypto.createHash("sha1").update(googleEventId).digest("hex");
  return `${importedEventDocPrefix(subAccountId, uid)}${h.slice(0, 16)}`;
}

function importedEventDocPrefix(subAccountId: string, uid: string): string {
  return `gcal_${subAccountId}_${uid}_`;
}

function tsMs(v: unknown): number {
  return (v as { toMillis?: () => number } | null)?.toMillis?.() ?? 0;
}

interface GoogleDateTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

interface GoogleAttendee {
  email?: string;
  self?: boolean;
  responseStatus?: string;
}

interface GoogleEvent {
  id?: string;
  etag?: string;
  status?: string;
  summary?: string;
  location?: string;
  visibility?: string;
  transparency?: string;
  eventType?: string;
  start?: GoogleDateTime;
  end?: GoogleDateTime;
  attendees?: GoogleAttendee[];
  extendedProperties?: { private?: Record<string, string> };
}

interface GoogleEventsPage {
  items?: GoogleEvent[];
  nextPageToken?: string;
  timeZone?: string;
}

/** Minimal field mask; descriptions, links and attachments are never requested. */
const FIELDS =
  "nextPageToken,timeZone,items(id,etag,status,summary,location,visibility,transparency,eventType,start,end,attendees(email,self,responseStatus),extendedProperties/private)";

async function listGoogleEvents(
  subAccountId: string,
  uid: string,
  opts: { timeMin: Date; timeMax: Date; updatedMin?: Date; deadlineMs: number },
): Promise<{ items: GoogleEvent[]; timeZone: string; truncated: boolean }> {
  const token = await getAccessToken(subAccountId, uid);
  const items: GoogleEvent[] = [];
  let timeZone = "UTC";
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    if (Date.now() > opts.deadlineMs - DEADLINE_MARGIN_MS) {
      return { items, timeZone, truncated: true };
    }
    const params = new URLSearchParams({
      singleEvents: "true",
      showDeleted: "true",
      maxResults: "250",
      timeMin: opts.timeMin.toISOString(),
      timeMax: opts.timeMax.toISOString(),
      fields: FIELDS,
    });
    if (opts.updatedMin) params.set("updatedMin", opts.updatedMin.toISOString());
    if (pageToken) params.set("pageToken", pageToken);
    let res: Response;
    try {
      res = await fetch(`${CALENDAR_API}/calendars/primary/events?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
      });
    } catch {
      throw new GoogleCalendarError("timeout", "Google events list timed out.");
    }
    if (res.status === 401 || res.status === 403) {
      const body = (await res.json().catch(() => ({}))) as {
        error?: { errors?: Array<{ reason?: string }> };
      };
      const reason = body.error?.errors?.[0]?.reason ?? "";
      if (res.status === 403 && RATE_LIMIT_REASONS.has(reason)) {
        throw new GoogleCalendarError("api_error", `Google rate limit (${reason}).`, 403);
      }
      await markConnectionError(subAccountId, uid, "reconnect_required");
      throw new GoogleCalendarError(
        "reconnect_required",
        `Google events list auth failed (${res.status}${reason ? ` ${reason}` : ""}).`,
        res.status,
      );
    }
    if (!res.ok) {
      throw new GoogleCalendarError(
        "api_error",
        `Google events list failed (${res.status}).`,
        res.status,
      );
    }
    const data = (await res.json().catch(() => ({}))) as GoogleEventsPage;
    if (data.timeZone) timeZone = data.timeZone;
    items.push(...(data.items ?? []));
    pageToken = data.nextPageToken;
    if (!pageToken) return { items, timeZone, truncated: false };
  }
  return { items, timeZone, truncated: true };
}

/** UTC instant of 00:00 on `date` (YYYY-MM-DD) in `timeZone`. */
function zonedMidnight(date: string, timeZone: string): Date | null {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return null;
  const guess = Date.UTC(y, m - 1, d);
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const offsetAt = (ms: number) => {
      const parts = fmt.formatToParts(new Date(ms));
      const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
      return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - ms;
    };
    // Second pass uses the offset at the result, which differs on DST days.
    const first = guess - offsetAt(guess);
    return new Date(guess - offsetAt(first));
  } catch {
    return new Date(guess);
  }
}

function toInstant(
  dt: GoogleDateTime | undefined,
  timeZone: string,
): { at: Date; date: string | null } | null {
  if (!dt) return null;
  if (dt.dateTime) {
    const at = new Date(dt.dateTime);
    return Number.isNaN(at.getTime()) ? null : { at, date: null };
  }
  if (dt.date) {
    const at = zonedMidnight(dt.date, dt.timeZone || timeZone);
    return at ? { at, date: dt.date } : null;
  }
  return null;
}

type Upsert = {
  kind: "upsert";
  googleEventId: string;
  etag: string | null;
  title: string;
  location: string;
  startAt: Date;
  endAt: Date;
  /** YYYY-MM-DD, set only for all-day events (end exclusive, as Google sends it). */
  allDayStart: string | null;
  allDayEnd: string | null;
  attendeeEmails: string[];
};
type Mapped = { kind: "skip" } | { kind: "delete" } | Upsert;

/**
 * Privacy rules live here: busy mode and Google-private events carry no
 * title or location; Free, declined and non-appointment entries are skipped;
 * our own pushed copies are skipped so nothing loops.
 */
function mapGoogleEvent(
  ev: GoogleEvent,
  mode: Exclude<CalendarImportMode, "off">,
  timeZone: string,
): Mapped {
  if (!ev.id) return { kind: "skip" };
  if (ev.status === "cancelled") return { kind: "delete" };
  if (ev.extendedProperties?.private?.leadstackEventId) return { kind: "delete" };
  if (ev.transparency === "transparent") return { kind: "delete" };
  if (ev.eventType && SKIPPED_EVENT_TYPES.has(ev.eventType)) return { kind: "delete" };
  const self = ev.attendees?.find((a) => a.self);
  if (self?.responseStatus === "declined") return { kind: "delete" };

  const start = toInstant(ev.start, timeZone);
  const end = toInstant(ev.end, timeZone);
  if (!start || !end || end.at.getTime() <= start.at.getTime()) return { kind: "delete" };

  const isPrivate = ev.visibility === "private" || ev.visibility === "confidential";
  const showDetails = mode === "details" && !isPrivate;
  const allDay = start.date !== null;
  return {
    kind: "upsert",
    googleEventId: ev.id,
    etag: ev.etag ?? null,
    title: showDetails ? (ev.summary?.trim() || "(No title)").slice(0, 200) : BUSY_TITLE,
    location: showDetails ? (ev.location?.trim() ?? "").slice(0, 200) : "",
    startAt: start.at,
    endAt: end.at,
    allDayStart: allDay ? start.date : null,
    allDayEnd: allDay ? end.date : null,
    attendeeEmails: showDetails
      ? (ev.attendees ?? [])
          .filter((a) => !a.self && a.email)
          .map((a) => a.email!.trim().toLowerCase())
          .slice(0, 30)
      : [],
  };
}

/** One lookup for every guest email in the pass, 30 per query. */
async function loadContactsByEmail(
  subAccountId: string,
  emails: string[],
): Promise<Map<string, string[]>> {
  const unique = [...new Set(emails)];
  const byEmail = new Map<string, string[]>();
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += 30) chunks.push(unique.slice(i, i + 30));
  const snaps = await Promise.all(
    chunks.map((c) =>
      getAdminDb()
        .collection("contacts")
        .where("subAccountId", "==", subAccountId)
        .where("email", "in", c)
        .get(),
    ),
  );
  for (const snap of snaps) {
    for (const d of snap.docs) {
      const email = String(d.data().email ?? "").trim().toLowerCase();
      byEmail.set(email, [...(byEmail.get(email) ?? []), d.id]);
    }
  }
  return byEmail;
}

/** Exactly one contact across the guest emails, else null (never guess). */
function pickContact(emails: string[], byEmail: Map<string, string[]>): string | null {
  const ids = new Set<string>();
  for (const e of emails) for (const id of byEmail.get(e) ?? []) ids.add(id);
  return ids.size === 1 ? [...ids][0] : null;
}

interface ExistingImport {
  etag: string | null;
  mode: string | null;
  contactId: string | null;
  ownerName: string | null;
}

function existingFrom(data: FirebaseFirestore.DocumentData): ExistingImport {
  return {
    etag: (data.googleEtag as string | null) ?? null,
    mode: (data.importMode as string | null) ?? null,
    contactId: (data.contactId as string | null) ?? null,
    ownerName: (data.importOwnerName as string | null) ?? null,
  };
}

function importedQuery(subAccountId: string, uid?: string) {
  let q = getAdminDb()
    .collection("events")
    .where("subAccountId", "==", subAccountId)
    .where("source", "==", IMPORT_SOURCE);
  if (uid) q = q.where("importOwnerUid", "==", uid);
  return q;
}

async function loadAllImported(
  subAccountId: string,
  uid: string,
): Promise<Map<string, ExistingImport>> {
  const snap = await importedQuery(subAccountId, uid).get();
  return new Map(snap.docs.map((d) => [d.id, existingFrom(d.data())]));
}

/** Incremental passes read only the docs Google says changed. */
async function loadImportedByIds(ids: string[]): Promise<Map<string, ExistingImport>> {
  const db = getAdminDb();
  const out = new Map<string, ExistingImport>();
  for (let i = 0; i < ids.length; i += 100) {
    const refs = ids.slice(i, i + 100).map((id) => db.collection("events").doc(id));
    if (refs.length === 0) continue;
    const snaps = await db.getAll(...refs);
    for (const s of snaps) if (s.exists) out.set(s.id, existingFrom(s.data()!));
  }
  return out;
}

async function commitInBatches(
  ops: Array<(b: FirebaseFirestore.WriteBatch) => void>,
  beforeEach?: () => Promise<boolean>,
): Promise<boolean> {
  const db = getAdminDb();
  for (let i = 0; i < ops.length; i += BATCH_SIZE) {
    if (beforeEach && !(await beforeEach())) return false;
    const batch = db.batch();
    for (const op of ops.slice(i, i + BATCH_SIZE)) op(batch);
    await batch.commit();
  }
  return true;
}

/**
 * Deletes imported events: one member's, or (no uid) the whole workspace's.
 * The privacy cleanup path, so it runs inside the request that turns
 * something off. Returns how many were removed.
 */
export async function deleteImportedEvents(
  subAccountId: string,
  uid?: string,
): Promise<number> {
  const snap = await importedQuery(subAccountId, uid).get();
  await commitInBatches(snap.docs.map((d) => (b) => b.delete(d.ref)));
  return snap.size;
}

/** Busy-only right now, before the next sync: titles, places and contacts go. */
export async function stripImportedDetails(
  subAccountId: string,
  uid: string,
): Promise<void> {
  const snap = await importedQuery(subAccountId, uid).get();
  await commitInBatches(
    snap.docs.map((d) => (b) =>
      b.update(d.ref, {
        title: BUSY_TITLE,
        location: "",
        contactId: null,
        importMode: "busy",
        // Forces a rewrite on the next pass even if Google's etag is unchanged.
        googleEtag: null,
        updatedAt: FieldValue.serverTimestamp(),
      }),
    ),
  );
}

/**
 * Makes stored imports match the member's CURRENT settings: delete when any
 * key is off, strip details in busy mode. Called after a sync notices its
 * settings changed mid-run, so a cleanup that raced the sync still wins.
 */
async function enforceCurrentImportState(subAccountId: string, uid: string): Promise<void> {
  const [subSnap, connSnap, active] = await Promise.all([
    getAdminDb().doc(`subAccounts/${subAccountId}`).get(),
    calendarConnectionRef(subAccountId, uid).get(),
    isActiveCalendarOwner(subAccountId, uid),
  ]);
  const conn = connSnap.exists ? (connSnap.data() as CalendarConnectionDoc) : null;
  if (
    !workspaceAllowsImport(subSnap.data() as SubAccountDoc | undefined) ||
    !conn ||
    !importModeOn(conn.importMode) ||
    !active
  ) {
    await deleteImportedEvents(subAccountId, uid);
  } else if (conn.importMode === "busy") {
    await stripImportedDetails(subAccountId, uid);
  }
}

/**
 * Settings fingerprint a sync started under. Every cleanup bumps a counter
 * (or deletes the connection) BEFORE removing data, so a changed fingerprint
 * means the sync must not keep what it wrote.
 */
function fingerprintOf(
  sub: SubAccountDoc | undefined,
  conn: CalendarConnectionDoc | null,
): string {
  return [
    workspaceAllowsImport(sub) ? "on" : "off",
    sub?.calendarImportGeneration ?? 0,
    conn ? conn.importMode ?? "off" : "none",
    conn?.importGeneration ?? 0,
  ].join("|");
}

async function importFingerprint(subAccountId: string, uid: string): Promise<string> {
  const [subSnap, connSnap] = await Promise.all([
    getAdminDb().doc(`subAccounts/${subAccountId}`).get(),
    calendarConnectionRef(subAccountId, uid).get(),
  ]);
  return fingerprintOf(
    subSnap.data() as SubAccountDoc | undefined,
    connSnap.exists ? (connSnap.data() as CalendarConnectionDoc) : null,
  );
}

export interface ImportResult {
  ok: boolean;
  skipped?:
    | "not_allowed"
    | "not_opted_in"
    | "not_connected"
    | "not_active"
    | "no_workspace"
    | "settings_changed";
  full?: boolean;
  written?: number;
  deleted?: number;
  error?: string;
}

/**
 * One sync pass for one member. Full passes (first run, mode change, daily)
 * reconcile the whole window and delete anything Google no longer returns;
 * incremental passes only apply changes since the last sync.
 */
export async function runCalendarImport(
  subAccountId: string,
  uid: string,
  opts: { full?: boolean; deadlineMs?: number } = {},
): Promise<ImportResult> {
  const db = getAdminDb();
  const deadlineMs = opts.deadlineMs ?? Date.now() + 45_000;
  const [subSnap, connSnap, memberSnap, memberActive] = await Promise.all([
    db.doc(`subAccounts/${subAccountId}`).get(),
    calendarConnectionRef(subAccountId, uid).get(),
    db.doc(`subAccounts/${subAccountId}/subAccountMembers/${uid}`).get(),
    isActiveCalendarOwner(subAccountId, uid),
  ]);
  if (!subSnap.exists) return { ok: false, skipped: "no_workspace" };
  const sub = subSnap.data() as SubAccountDoc;
  const conn = connSnap.exists ? (connSnap.data() as CalendarConnectionDoc) : null;
  // Same snapshot as the gate below, so a cleanup that lands after these
  // reads always shows up as a change.
  const startPrint = fingerprintOf(sub, conn);

  // Any key missing means nothing of this member's calendar may stay visible.
  if (!workspaceAllowsImport(sub) || !conn || !importModeOn(conn.importMode) || !memberActive) {
    const deleted = await deleteImportedEvents(subAccountId, uid);
    return {
      ok: true,
      skipped: !workspaceAllowsImport(sub)
        ? "not_allowed"
        : !conn
          ? "not_connected"
          : !memberActive
            ? "not_active"
            : "not_opted_in",
      deleted,
    };
  }
  if (conn.status !== "connected") return { ok: false, skipped: "not_connected" };
  const mode = conn.importMode as Exclude<CalendarImportMode, "off">;

  const now = Date.now();
  const lastFull = tsMs(conn.importLastFullSyncAt);
  const lastSync = tsMs(conn.importLastSyncAt);
  // Docs from before ids were workspace-scoped are only found by a full pass.
  const legacyIds = conn.importIdsScoped !== true;
  const full =
    opts.full === true ||
    legacyIds ||
    !lastFull ||
    now - lastFull > FULL_SYNC_EVERY_MS ||
    !lastSync;
  const timeMin = new Date(now - WINDOW_BACK_MS);
  const timeMax = new Date(now + WINDOW_AHEAD_MS);
  // Rotation key, so a pass that dies mid-run doesn't keep jumping the queue.
  await calendarConnectionRef(subAccountId, uid)
    .update({ importLastAttemptAt: Timestamp.fromMillis(now) })
    .catch(() => {});

  const unchanged = async () => (await importFingerprint(subAccountId, uid)) === startPrint;

  try {
    const { items, timeZone, truncated } = await listGoogleEvents(subAccountId, uid, {
      timeMin,
      timeMax,
      updatedMin: full ? undefined : new Date(lastSync - INCREMENTAL_OVERLAP_MS),
      deadlineMs,
    });
    const mapped = items
      .filter((ev) => ev.id)
      .map((ev) => ({
        id: importedEventDocId(subAccountId, uid, ev.id!),
        m: mapGoogleEvent(ev, mode, timeZone),
      }));
    const existing = full
      ? await loadAllImported(subAccountId, uid)
      : await loadImportedByIds(mapped.map((x) => x.id));
    const memberName =
      (memberSnap.data()?.displayName as string | undefined) ||
      (memberSnap.data()?.email as string | undefined) ||
      null;

    // Upcoming first, so a very busy calendar keeps what's ahead.
    const upserts = mapped
      .filter((x): x is { id: string; m: Upsert } => x.m.kind === "upsert")
      .sort((a, b) => {
        const aPast = a.m.endAt.getTime() < now;
        const bPast = b.m.endAt.getTime() < now;
        if (aPast !== bPast) return aPast ? 1 : -1;
        return aPast
          ? b.m.startAt.getTime() - a.m.startAt.getTime()
          : a.m.startAt.getTime() - b.m.startAt.getTime();
      });
    const capped = upserts.slice(0, MAX_EVENTS_PER_MEMBER);
    const tooMany = upserts.length > capped.length;

    const contactsByEmail =
      mode === "details"
        ? await loadContactsByEmail(subAccountId, capped.flatMap((x) => x.m.attendeeEmails))
        : new Map<string, string[]>();

    const ops: Array<(b: FirebaseFirestore.WriteBatch) => void> = [];
    const kept = new Set<string>();
    const deletedIds = new Set<string>();
    let written = 0;
    let created = 0;
    for (const { id, m: u } of capped) {
      kept.add(id);
      const contactId = mode === "details" ? pickContact(u.attendeeEmails, contactsByEmail) : null;
      const prev = existing.get(id);
      if (
        prev &&
        prev.etag &&
        prev.etag === u.etag &&
        prev.mode === mode &&
        prev.contactId === contactId &&
        prev.ownerName === memberName
      ) {
        continue;
      }
      const ref = db.collection("events").doc(id);
      ops.push((b) =>
        b.set(ref, {
          title: u.title,
          startAt: Timestamp.fromDate(u.startAt),
          endAt: Timestamp.fromDate(u.endAt),
          allDay: u.allDayStart !== null,
          allDayStart: u.allDayStart,
          allDayEnd: u.allDayEnd,
          contactId,
          location: u.location,
          notes: "",
          meetingUrl: null,
          status: "scheduled",
          source: IMPORT_SOURCE,
          importMode: mode,
          importOwnerUid: uid,
          importOwnerName: memberName,
          importedGoogleEventId: u.googleEventId,
          googleEtag: u.etag,
          territoryId: "global",
          agencyId: sub.agencyId,
          subAccountId,
          createdByUid: IMPORT_CREATOR,
          // Not "live"/"test", so the public API (which filters on mode) never
          // lists, reads, edits or deletes a staff member's calendar.
          mode: "import",
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        }),
      );
      written++;
      if (!prev) created++;
    }

    const queueDelete = (id: string) => {
      if (kept.has(id) || deletedIds.has(id) || !existing.has(id)) return;
      deletedIds.add(id);
      ops.push((b) => b.delete(db.collection("events").doc(id)));
    };
    // Cancelled, Free, declined or otherwise no longer importable.
    for (const x of mapped) if (x.m.kind !== "upsert") queueDelete(x.id);
    // Over the cap: the dropped ones shouldn't linger either.
    for (const x of upserts.slice(capped.length)) queueDelete(x.id);
    if (full && !truncated) {
      // Anything Google no longer returns (deleted, or slid out of the window).
      // This also clears docs that still use the old, workspace-less id.
      for (const id of existing.keys()) queueDelete(id);
    } else if (full) {
      // A truncated listing can't prove absence, so only drop an old-format doc
      // once its event has been rewritten under the new id (same hash suffix).
      const ownPrefix = importedEventDocPrefix(subAccountId, uid);
      const rewritten = new Set([...kept].map((id) => id.slice(ownPrefix.length)));
      for (const id of existing.keys()) {
        if (!id.startsWith(ownPrefix) && rewritten.has(id.slice(-16))) queueDelete(id);
      }
    }

    const committed = await commitInBatches(ops, unchanged);
    // Settings changed while we were working: make sure their cleanup wins.
    if (!committed || !(await unchanged())) {
      await enforceCurrentImportState(subAccountId, uid);
      return { ok: true, skipped: "settings_changed", full };
    }

    const deletedExisting = deletedIds.size;
    const count = full
      ? capped.length
      : Math.max(0, (conn.importedCount ?? 0) + created - deletedExisting);
    const importError = full
      ? tooMany
        ? "too_many_events"
        : truncated
          ? "partial_sync"
          : null
      : truncated
        ? "partial_sync"
        : (conn.importError === "too_many_events" ? "too_many_events" : null);
    // In a transaction so a cleanup that just ran can't be undone by a stale
    // "ok" status or count.
    const stillCurrent = await db.runTransaction(async (txn) => {
      const [s, c] = await Promise.all([
        txn.get(db.doc(`subAccounts/${subAccountId}`)),
        txn.get(calendarConnectionRef(subAccountId, uid)),
      ]);
      const print = fingerprintOf(
        s.data() as SubAccountDoc | undefined,
        c.exists ? (c.data() as CalendarConnectionDoc) : null,
      );
      if (print !== startPrint) return false;
      txn.update(calendarConnectionRef(subAccountId, uid), {
        importStatus: "ok",
        importError,
        // A partial incremental pass keeps the old sync point so the pages it
        // missed are fetched next time.
        ...(truncated && !full ? {} : { importLastSyncAt: Timestamp.fromMillis(now) }),
        ...(full && !truncated ? { importLastFullSyncAt: Timestamp.fromMillis(now) } : {}),
        ...(full && !truncated ? { importIdsScoped: true } : {}),
        importedCount: count,
        updatedAt: FieldValue.serverTimestamp(),
      });
      return true;
    });
    if (!stillCurrent) {
      await enforceCurrentImportState(subAccountId, uid);
      return { ok: true, skipped: "settings_changed", full };
    }
    return { ok: true, full, written, deleted: deletedExisting };
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    // Some batches may have committed; if settings moved meanwhile, honour them.
    await (async () => {
      if (!(await unchanged())) await enforceCurrentImportState(subAccountId, uid);
    })().catch(() => {});
    await calendarConnectionRef(subAccountId, uid)
      .update({
        importStatus: "error",
        importError: message.slice(0, 200),
        updatedAt: FieldValue.serverTimestamp(),
      })
      .catch(() => {});
    console.warn(
      `[google/calendar-import] sync failed sa=${subAccountId} uid=${uid}`,
      message,
    );
    return { ok: false, full, error: message };
  }
}

/**
 * Sets a member's mode. The counter bump comes first so any sync already
 * running sees the change and defers to this cleanup.
 */
export async function setImportMode(
  subAccountId: string,
  uid: string,
  mode: CalendarImportMode,
): Promise<number> {
  const ref = calendarConnectionRef(subAccountId, uid);
  const snap = await ref.get();
  const prevMode = snap.exists ? (snap.data() as CalendarConnectionDoc).importMode : undefined;
  if (snap.exists) {
    await ref.update({
      importMode: mode,
      importGeneration: FieldValue.increment(1),
      importLastFullSyncAt: null,
      ...(mode === "off"
        ? { importedCount: 0, importStatus: null, importError: null }
        : {}),
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
  if (mode === "off") return deleteImportedEvents(subAccountId, uid);
  if (mode === "busy" && prevMode === "details") {
    await stripImportedDetails(subAccountId, uid);
  }
  return 0;
}

/**
 * Admin switch. Off resets every member to Off too, so turning it back on
 * later never re-exposes anyone's calendar without them choosing again.
 */
export async function setWorkspaceImportAllowed(
  subAccountId: string,
  allowed: boolean,
): Promise<number> {
  const db = getAdminDb();
  await db.doc(`subAccounts/${subAccountId}`).update({
    calendarImportAllowed: allowed,
    calendarImportGeneration: FieldValue.increment(1),
    updatedAt: FieldValue.serverTimestamp(),
  });
  if (allowed) return 0;
  const conns = await db.collection(`subAccounts/${subAccountId}/calendarConnections`).get();
  await commitInBatches(
    conns.docs
      .filter((d) => importModeOn((d.data() as CalendarConnectionDoc).importMode))
      .map((d) => (b) =>
        b.update(d.ref, {
          importMode: "off",
          importGeneration: FieldValue.increment(1),
          importedCount: 0,
          updatedAt: FieldValue.serverTimestamp(),
        }),
      ),
  );
  return deleteImportedEvents(subAccountId);
}

/**
 * Full disconnect: revoke at Google, delete the token and status docs, then
 * their imported events (status doc first, so a running sync sees it gone).
 */
export async function removeCalendarConnection(
  subAccountId: string,
  uid: string,
  opts: { revoke?: boolean } = {},
): Promise<void> {
  const privRef = calendarPrivateRef(subAccountId, uid);
  const privSnap = await privRef.get();
  const refreshToken = privSnap.data()?.refreshToken as string | undefined;
  // Revoking ends the grant for every workspace on this deployment, so only
  // do it when the person themselves disconnects.
  if (refreshToken && opts.revoke !== false) await revokeGoogleToken(refreshToken);
  await Promise.all([privRef.delete(), calendarConnectionRef(subAccountId, uid).delete()]);
  await deleteImportedEvents(subAccountId, uid);
}

/** Connections that should sync, least recently attempted first. */
export async function listImportTargets(): Promise<
  Array<{ subAccountId: string; uid: string }>
> {
  const db = getAdminDb();
  const subs = await db
    .collection("subAccounts")
    .where("calendarImportAllowed", "==", true)
    .get();
  const targets: Array<{ subAccountId: string; uid: string; lastMs: number }> = [];
  for (const s of subs.docs) {
    const conns = await db.collection(`subAccounts/${s.id}/calendarConnections`).get();
    for (const c of conns.docs) {
      const data = c.data() as CalendarConnectionDoc;
      if (!importModeOn(data.importMode) || data.status !== "connected") continue;
      const lastMs = Math.max(tsMs(data.importLastSyncAt), tsMs(data.importLastAttemptAt));
      targets.push({ subAccountId: s.id, uid: c.id, lastMs });
    }
  }
  return targets
    .sort((a, b) => a.lastMs - b.lastMs)
    .map(({ subAccountId, uid }) => ({ subAccountId, uid }));
}

/**
 * Safety net for anything a failed cleanup left behind: deletes imported docs
 * whose workspace, member or opt-in no longer allows them. Runs once a day.
 */
export async function sweepOrphanedImports(deadlineMs: number): Promise<number> {
  const db = getAdminDb();
  const verdict = new Map<string, Promise<boolean>>();
  const eligible = (subAccountId: string, uid: string) => {
    const key = `${subAccountId}|${uid}`;
    if (!verdict.has(key)) {
      verdict.set(
        key,
        (async () => {
          const [subSnap, connSnap, active] = await Promise.all([
            db.doc(`subAccounts/${subAccountId}`).get(),
            calendarConnectionRef(subAccountId, uid).get(),
            isActiveCalendarOwner(subAccountId, uid),
          ]);
          const conn = connSnap.exists ? (connSnap.data() as CalendarConnectionDoc) : null;
          return (
            workspaceAllowsImport(subSnap.data() as SubAccountDoc | undefined) &&
            !!conn &&
            importModeOn(conn.importMode) &&
            active
          );
        })(),
      );
    }
    return verdict.get(key)!;
  };

  let removed = 0;
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | null = null;
  while (Date.now() < deadlineMs) {
    let q = db
      .collection("events")
      .where("source", "==", IMPORT_SOURCE)
      .orderBy("__name__")
      .select("subAccountId", "importOwnerUid")
      .limit(500);
    if (cursor) q = q.startAfter(cursor);
    const page = await q.get();
    if (page.empty) break;
    const doomed: FirebaseFirestore.DocumentReference[] = [];
    for (const d of page.docs) {
      const sa = d.get("subAccountId") as string | undefined;
      const uid = d.get("importOwnerUid") as string | undefined;
      if (!sa || !uid || !(await eligible(sa, uid))) doomed.push(d.ref);
    }
    await commitInBatches(doomed.map((ref) => (b) => b.delete(ref)));
    removed += doomed.length;
    cursor = page.docs[page.docs.length - 1];
    if (page.size < 500) break;
  }
  return removed;
}
