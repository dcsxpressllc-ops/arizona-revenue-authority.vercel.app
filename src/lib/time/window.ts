// Timezone-aware daily send window, shared by the outbound-voice compliance gate
// and the automation step scheduler: seconds until we may act inside
// [startHour, endHour) in an IANA timezone (0 = inside now).

export interface DailyWindow {
  /** Local hour the window opens (0-23). */
  startHour: number;
  /** Exclusive, 1-24. */
  endHour: number;
  /** e.g. "Australia/Sydney". */
  timezone: string;
}

/**
 * 0 inside the window (or for a null/invalid window), else seconds until the
 * next start. Reads wall-clock time via Intl.DateTimeFormat; DST transitions can
 * be off by an hour, which is acceptable here.
 */
export function computeWindowDeferralSeconds(
  window: DailyWindow | null | undefined,
): number {
  if (!window) return 0;
  const { startHour, endHour, timezone } = window;
  if (
    !Number.isFinite(startHour) ||
    !Number.isFinite(endHour) ||
    startHour >= endHour ||
    !timezone
  ) {
    return 0;
  }

  let h = 0;
  let m = 0;
  let s = 0;
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts = fmt.formatToParts(new Date());
    const get = (t: string) =>
      parseInt(parts.find((p) => p.type === t)?.value ?? "0", 10);
    h = get("hour") % 24; // some Intl impls return 24 instead of 0 at midnight
    m = get("minute");
    s = get("second");
  } catch (err) {
    console.warn(
      `[time/window] invalid timezone "${timezone}" — treating as inside window`,
      err,
    );
    return 0;
  }

  const currentSecsOfDay = h * 3600 + m * 60 + s;
  const startSecs = startHour * 3600;
  const endSecs = endHour * 3600;

  if (currentSecsOfDay >= startSecs && currentSecsOfDay < endSecs) {
    return 0; // inside window
  }
  if (currentSecsOfDay < startSecs) {
    return startSecs - currentSecsOfDay; // later today
  }
  // Past the end: tomorrow's start (naive across DST).
  return 24 * 3600 - currentSecsOfDay + startSecs;
}
