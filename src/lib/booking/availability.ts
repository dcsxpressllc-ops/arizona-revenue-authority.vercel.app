import type { BookingPage, WorkingHour } from "@/types/booking";

/**
 * Pure slot-availability calculator: page + now + window + busy events in,
 * free UTC slots out. Used for listing and for the book-time re-check.
 *
 * Timezones use Intl.DateTimeFormat, so DST works without a date library:
 * guess a UTC instant with the wanted wall-clock fields, see what the target tz
 * shows for it, and subtract the difference.
 */

export interface SlotCandidate {
  startAt: Date;
  /** start + durationMinutes */
  endAt: Date;
}

export interface BusyEvent {
  startAt: Date;
  endAt: Date;
}

export interface AvailabilityInput {
  page: BookingPage;
  /** Bookable horizon is relative to this. */
  now: Date;
  /** Defaults to `now`. */
  fromInstant?: Date;
  /** Defaults to `now + page.visibleDays`. */
  toInstant?: Date;
  /**
   * Caller filters with `eventOccupiesSlot()` (scheduled + awaiting_payment, so
   * unpaid holds block too) so cancelled meetings don't block.
   */
  busy: BusyEvent[];
  /**
   * Skip the min-notice filter. Only for re-verifying a slot that was already
   * offered: min-notice moves with "now", so re-applying it at confirm time can
   * reject a slot that was fine when shown (e.g. during a voice call). Overlap
   * and working-hours checks still run.
   */
  ignoreMinNotice?: boolean;
  /** Per-host hours used instead of `page.workingHours`; everything else unchanged. */
  workingHoursOverride?: WorkingHour[];
}

/** Wall-clock fields of `instant` in an IANA timezone. */
function wallClockInTz(
  instant: Date,
  tz: string,
): {
  year: number;
  month: number; // 1-12, not JS 0-11
  day: number;
  hour: number;
  minute: number;
  second: number;
  dayOfWeek: WorkingHour["dayOfWeek"];
} {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const parts = fmt.formatToParts(instant);
  const get = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? "0";
  const year = Number(get("year"));
  const month = Number(get("month"));
  const day = Number(get("day"));
  // Some engines return "24" at midnight with hour12: false.
  let hour = Number(get("hour"));
  if (hour === 24) hour = 0;
  const minute = Number(get("minute"));
  const second = Number(get("second"));
  const weekdayMap: Record<string, WorkingHour["dayOfWeek"]> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const dayOfWeek = weekdayMap[get("weekday")] ?? 0;
  return { year, month, day, hour, minute, second, dayOfWeek };
}

/**
 * Wall-clock time in a tz to its UTC instant, DST-safe (see file header).
 * Exported for other callers, e.g. the AI Suite create_event capability.
 */
export function utcFromWallClock(
  year: number,
  month: number, // 1-12
  day: number,
  minuteOfDay: number,
  tz: string,
): Date {
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  // Pretend the wall-clock fields are UTC...
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
  // ...see what that instant shows in the tz...
  const wc = wallClockInTz(guess, tz);
  const seenAsUtc = Date.UTC(
    wc.year,
    wc.month - 1,
    wc.day,
    wc.hour,
    wc.minute,
    wc.second,
  );
  // ...and the difference is the tz offset at that moment.
  const offset = seenAsUtc - guess.getTime();
  return new Date(guess.getTime() - offset);
}

/** Candidate starts in one working-hour range on one tz day. The last slot must fit entirely. */
function* slotsForRange(
  page: BookingPage,
  year: number,
  month: number,
  day: number,
  range: WorkingHour,
): Generator<SlotCandidate> {
  const step = page.durationMinutes + page.bufferMinutes;
  const lastStartMinute = range.endMinute - page.durationMinutes;
  for (let m = range.startMinute; m <= lastStartMinute; m += step) {
    const start = utcFromWallClock(year, month, day, m, page.timezone);
    const end = new Date(start.getTime() + page.durationMinutes * 60_000);
    yield { startAt: start, endAt: end };
  }
}

/** Free slots, ascending. O(slots x busy) overlap check, fine at a few hundred of each. */
export function computeAvailability(input: AvailabilityInput): SlotCandidate[] {
  const { page, now, busy } = input;
  const workingHours = input.workingHoursOverride ?? page.workingHours;
  // Clamped so callers can't ask past the page's visibleDays.
  const horizonEnd = new Date(
    now.getTime() + page.visibleDays * 24 * 60 * 60_000,
  );
  const minBookable = input.ignoreMinNotice
    ? now
    : new Date(now.getTime() + page.minNoticeHours * 60 * 60_000);
  const fromInstant = input.fromInstant
    ? new Date(Math.max(input.fromInstant.getTime(), minBookable.getTime()))
    : minBookable;
  const toInstant = input.toInstant
    ? new Date(Math.min(input.toInstant.getTime(), horizonEnd.getTime()))
    : horizonEnd;

  if (fromInstant >= toInstant || workingHours.length === 0) {
    return [];
  }

  const rangesByDow = new Map<WorkingHour["dayOfWeek"], WorkingHour[]>();
  for (let d = 0; d <= 6; d++) {
    rangesByDow.set(d as WorkingHour["dayOfWeek"], []);
  }
  for (const r of workingHours) {
    rangesByDow.get(r.dayOfWeek)!.push(r);
  }

  // Walk one tz day at a time from the day fromInstant falls in. Step with UTC
  // math but re-derive the tz day each time so DST can't drift us.
  const startWc = wallClockInTz(fromInstant, page.timezone);
  // Anchor at noon UTC, far enough from midnight that DST can't move the day.
  let cursor = new Date(
    Date.UTC(startWc.year, startWc.month - 1, startWc.day, 12, 0, 0),
  );
  const endWc = wallClockInTz(toInstant, page.timezone);
  const endAnchor = new Date(
    Date.UTC(endWc.year, endWc.month - 1, endWc.day, 12, 0, 0),
  );

  const out: SlotCandidate[] = [];
  // For maxPerDay. Key: "YYYY-MM-DD" in tz.
  const dayCounts = new Map<string, number>();

  const busyRanges = busy
    .map((b) => [b.startAt.getTime(), b.endAt.getTime()] as [number, number])
    .sort((a, b) => a[0] - b[0]);

  function overlapsAny(slot: SlotCandidate): boolean {
    const s = slot.startAt.getTime();
    const e = slot.endAt.getTime();
    for (const [bs, be] of busyRanges) {
      if (bs >= e) break; // sorted, so nothing later can overlap
      if (be > s) return true;
    }
    return false;
  }

  // visibleDays is already capped at 90 by the validator; this is a backstop.
  let safety = 100;
  while (cursor <= endAnchor && safety-- > 0) {
    const wc = wallClockInTz(cursor, page.timezone);
    const dayKey = `${wc.year}-${String(wc.month).padStart(2, "0")}-${String(wc.day).padStart(2, "0")}`;
    const dayMax = page.maxPerDay ?? Infinity;
    for (const range of rangesByDow.get(wc.dayOfWeek) ?? []) {
      for (const slot of slotsForRange(
        page,
        wc.year,
        wc.month,
        wc.day,
        range,
      )) {
        if (slot.startAt < fromInstant) continue;
        if (slot.endAt > toInstant) continue;
        const count = dayCounts.get(dayKey) ?? 0;
        if (count >= dayMax) break;
        if (overlapsAny(slot)) continue;
        out.push(slot);
        dayCounts.set(dayKey, count + 1);
      }
    }
    // 24h from noon UTC stays at noon UTC across DST.
    cursor = new Date(cursor.getTime() + 24 * 60 * 60_000);
  }

  out.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
  return out;
}

/** assignedToUid null = shared/unassigned. */
export interface BusyEventWithHost extends BusyEvent {
  assignedToUid: string | null;
}

/**
 * Team mode: a slot is offered while any host is free. Shared busy events
 * (assignedToUid == null) block every host; a host's own bookings block only
 * them. Each host goes through computeAvailability with their own hours, so
 * `maxPerDay` becomes per-host.
 *
 * Pooled mode hides host identity and assigns at book time. With `onlyHostUid`
 * (customer picked a host) only that host's slots come back, and the same call
 * at book time guarantees the committed slot matches what was shown.
 */
export function computeUnionAvailability(input: {
  page: BookingPage;
  now: Date;
  fromInstant?: Date;
  toInstant?: Date;
  busy: BusyEventWithHost[];
  hostUids: string[];
  /** Must be one of `hostUids` (unknown = no slots). Absent = pooled union. */
  onlyHostUid?: string | null;
}): SlotCandidate[] {
  const sharedBusy: BusyEvent[] = input.busy
    .filter((b) => b.assignedToUid == null)
    .map((b) => ({ startAt: b.startAt, endAt: b.endAt }));

  const byHost = new Map<string, BusyEvent[]>();
  for (const uid of input.hostUids) byHost.set(uid, []);
  for (const b of input.busy) {
    if (b.assignedToUid != null && byHost.has(b.assignedToUid)) {
      byHost.get(b.assignedToUid)!.push({ startAt: b.startAt, endAt: b.endAt });
    }
  }

  // Empty or absent hours = inherit the page hours.
  const hoursByHost = new Map<string, WorkingHour[] | undefined>();
  for (const h of input.page.hosts ?? []) hoursByHost.set(h.uid, h.workingHours);

  const uids =
    input.onlyHostUid != null
      ? input.hostUids.filter((u) => u === input.onlyHostUid)
      : input.hostUids;

  // Two hosts free at the same time is one offered slot.
  const seen = new Map<number, SlotCandidate>();
  for (const uid of uids) {
    const hostBusy = byHost.get(uid) ?? [];
    const override = hoursByHost.get(uid);
    const slots = computeAvailability({
      page: input.page,
      now: input.now,
      fromInstant: input.fromInstant,
      toInstant: input.toInstant,
      busy: [...sharedBusy, ...hostBusy],
      workingHoursOverride:
        override && override.length > 0 ? override : undefined,
    });
    for (const s of slots) {
      if (!seen.has(s.startAt.getTime())) seen.set(s.startAt.getTime(), s);
    }
  }
  return [...seen.values()].sort(
    (a, b) => a.startAt.getTime() - b.startAt.getTime(),
  );
}

/**
 * Where an existing booking can move. A team booking keeps its host, so it
 * uses that host's hours and is blocked only by their own and shared events.
 */
export function computeRescheduleAvailability(input: {
  page: BookingPage;
  now: Date;
  fromInstant?: Date;
  toInstant?: Date;
  busy: BusyEventWithHost[];
  assignedToUid: string | null;
}): SlotCandidate[] {
  const hostUids = (input.page.hosts ?? []).map((h) => h.uid);
  if (input.assignedToUid && hostUids.includes(input.assignedToUid)) {
    return computeUnionAvailability({
      page: input.page,
      now: input.now,
      fromInstant: input.fromInstant,
      toInstant: input.toInstant,
      busy: input.busy,
      hostUids,
      onlyHostUid: input.assignedToUid,
    });
  }
  return computeAvailability({
    page: input.page,
    now: input.now,
    fromInstant: input.fromInstant,
    toInstant: input.toInstant,
    busy: input.busy.map((b) => ({ startAt: b.startAt, endAt: b.endAt })),
  });
}

/** Group slots by tz date ("YYYY-MM-DD") for the public page. */
export function groupSlotsByLocalDate(
  slots: SlotCandidate[],
  tz: string,
): Array<{ dateKey: string; slots: SlotCandidate[] }> {
  const groups = new Map<string, SlotCandidate[]>();
  for (const s of slots) {
    const wc = wallClockInTz(s.startAt, tz);
    const key = `${wc.year}-${String(wc.month).padStart(2, "0")}-${String(wc.day).padStart(2, "0")}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(s);
    else groups.set(key, [s]);
  }
  return [...groups.entries()]
    .map(([dateKey, slots]) => ({ dateKey, slots }))
    .sort((a, b) => a.dateKey.localeCompare(b.dateKey));
}

/** Book-time re-check: true only if `candidate` is still exactly one of the free slots (else 409). */
export function isSlotAvailable(
  candidate: SlotCandidate,
  freeSlots: SlotCandidate[],
): boolean {
  return freeSlots.some(
    (s) =>
      s.startAt.getTime() === candidate.startAt.getTime() &&
      s.endAt.getTime() === candidate.endAt.getTime(),
  );
}
