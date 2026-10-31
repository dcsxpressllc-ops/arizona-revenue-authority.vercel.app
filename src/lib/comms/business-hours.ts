/**
 * Business-hours check shared by the AI channels.
 *
 * Whole hours [0..24] in an IANA timezone. start === end is 24/7, start < end
 * is [start, end) with end=24 meaning through 23:59, start > end is overnight
 * (e.g. 22 to 6). A bad timezone falls back to UTC instead of failing closed,
 * so a typo can't silence every channel.
 */
export function isWithinBusinessHours(
  hoursStart: number,
  hoursEnd: number,
  timezone: string,
): boolean {
  const now = new Date();
  let hour: number;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone: timezone || "UTC",
    }).formatToParts(now);
    const hourPart = parts.find((p) => p.type === "hour");
    hour = hourPart ? Number(hourPart.value) : now.getUTCHours();
    if (!Number.isFinite(hour)) hour = now.getUTCHours();
    if (hour === 24) hour = 0;
  } catch {
    hour = now.getUTCHours();
  }

  const start = Math.max(0, Math.min(23, Math.floor(hoursStart)));
  // Clamp end to 24, not 23, or "until 24:00" would miss 23:00-23:59.
  const end = Math.max(0, Math.min(24, Math.floor(hoursEnd)));
  if (start === end) return true; // 24/7
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

/**
 * Seconds until the hours next open (0 when open now). Whole-hour precision
 * matches isWithinBusinessHours; a bad timezone falls back to UTC.
 */
export function secondsUntilBusinessHoursOpen(
  hoursStart: number,
  hoursEnd: number,
  timezone: string,
): number {
  if (isWithinBusinessHours(hoursStart, hoursEnd, timezone)) return 0;
  const now = new Date();
  let hour = now.getUTCHours();
  let minute = now.getUTCMinutes();
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "numeric",
      hour12: false,
      timeZone: timezone || "UTC",
    }).formatToParts(now);
    const h = Number(parts.find((p) => p.type === "hour")?.value);
    const m = Number(parts.find((p) => p.type === "minute")?.value);
    if (Number.isFinite(h)) hour = h === 24 ? 0 : h;
    if (Number.isFinite(m)) minute = m;
  } catch {
    // UTC fallback above.
  }
  const start = Math.max(0, Math.min(23, Math.floor(hoursStart)));
  const hoursAhead = (start - hour + 24) % 24 || 24;
  return Math.max(60, hoursAhead * 3600 - minute * 60);
}

/** Minimum open time left for the AI to start a conversation it can follow up. */
const MIN_OPEN_SECONDS_TO_START = 30 * 60;

/**
 * Seconds until the AI may open a conversation: 0 when hours are open with at
 * least 30 minutes left, else until the next opening. Invalid hours read as
 * always open, so a bad profile can't defer forever.
 */
export function secondsUntilAiCanConverse(
  hoursStart: number,
  hoursEnd: number,
  timezone: string,
): number {
  if (!Number.isFinite(hoursStart) || !Number.isFinite(hoursEnd)) return 0;
  const start = Math.max(0, Math.min(23, Math.floor(hoursStart)));
  const end = Math.max(0, Math.min(24, Math.floor(hoursEnd)));
  // 24/7, including 0 to 24, which never closes at midnight.
  if (start === end % 24) return 0;
  const untilOpen = secondsUntilBusinessHoursOpen(hoursStart, hoursEnd, timezone);
  if (untilOpen > 0) return untilOpen;

  const { hour, minute } = localHourMinute(timezone);
  const endHour = end % 24;
  const untilClose = ((endHour - hour + 24) % 24 || 24) * 3600 - minute * 60;
  if (untilClose >= MIN_OPEN_SECONDS_TO_START) return 0;
  // Closed hours between this closing and the next opening.
  const closedGap = ((start - endHour + 24) % 24) * 3600;
  return Math.max(60, untilClose + closedGap);
}

function localHourMinute(timezone: string): { hour: number; minute: number } {
  const now = new Date();
  let hour = now.getUTCHours();
  let minute = now.getUTCMinutes();
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "numeric",
      hour12: false,
      timeZone: timezone || "UTC",
    }).formatToParts(now);
    const h = Number(parts.find((p) => p.type === "hour")?.value);
    const m = Number(parts.find((p) => p.type === "minute")?.value);
    if (Number.isFinite(h)) hour = h === 24 ? 0 : h;
    if (Number.isFinite(m)) minute = m;
  } catch {
    // UTC fallback above.
  }
  return { hour, minute };
}
