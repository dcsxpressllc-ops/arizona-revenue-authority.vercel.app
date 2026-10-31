import {
  DEFAULT_MIN_NOTICE_HOURS,
  DEFAULT_REMINDER_OFFSETS_MINUTES,
  DEFAULT_VISIBLE_DAYS,
  type BookingPageFormData,
  type WorkingHour,
} from "@/types/booking";

// Shared by the editor's new-page form and the create route so a fresh page
// matches what the validator emits.

/** Mon-Fri 9am-5pm in the page's timezone. */
export function defaultWorkingHours(): WorkingHour[] {
  // dayOfWeek: 0=Sun ... 6=Sat (JS convention).
  return [1, 2, 3, 4, 5].map((d) => ({
    dayOfWeek: d as WorkingHour["dayOfWeek"],
    startMinute: 9 * 60, // 9:00
    endMinute: 17 * 60, // 17:00
  }));
}

/** Initial editor state; the API also uses it to fill fields the editor doesn't send. */
export function defaultBookingPageFormData(
  slug: string,
  timezone: string,
): BookingPageFormData {
  return {
    slug,
    name: "30-minute consultation",
    description: "",
    status: "draft",
    durationMinutes: 30,
    bufferMinutes: 0,
    workingHours: defaultWorkingHours(),
    timezone,
    visibleDays: DEFAULT_VISIBLE_DAYS,
    minNoticeHours: DEFAULT_MIN_NOTICE_HOURS,
    maxPerDay: null,
    intakeFields: [],
    logoUrl: null,
    accentColor: null,
    themePreset: null,
    meetingUrl: null,
    googleMeet: false,
    location: null,
    confirmationMessage: "",
    redirectUrl: null,
    redirectAppendParams: true,
    remindersEnabled: true,
    smsRemindersEnabled: false,
    reminderOffsetsMinutes: [...DEFAULT_REMINDER_OFFSETS_MINUTES],
    payment: null,
    defaultTerritoryId: null,
  };
}

/** Runtime tz (browser on the client, server tz on the server), else UTC. */
export function detectTimezone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) return tz;
  } catch {
    /* fall through */
  }
  return "UTC";
}
