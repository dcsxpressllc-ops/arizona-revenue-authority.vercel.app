import type { Timestamp, FieldValue } from "firebase/firestore";
import type { CheckoutThemeId } from "@/types/checkout-pages";

/*
 * Booking pages at `subAccounts/{saId}/bookingPages/{slug}`, served publicly
 * at /b/[saId]/[slug]. Writes go through Admin-SDK routes; the public page
 * reads server-side, so rules stay member-scoped.
 */

/** Only `published` pages are reachable at /b/. */
export type BookingPageStatus = "draft" | "published";

/**
 * One range in the page's timezone. A day can have several (lunch break);
 * a day with none is unavailable.
 */
export interface WorkingHour {
  /** 0 = Sunday ... 6 = Saturday. */
  dayOfWeek: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  /** Minutes from midnight. 0 <= startMinute < endMinute <= 1440. */
  startMinute: number;
  endMinute: number;
}

/**
 * How the meeting happens, one per booking page.
 *   video_link     the page's meetingUrl (Zoom, Teams, …)
 *   google_meet    a unique Meet link per booking (googleMeet)
 *   in_person      at the business's address (`value`)
 *   we_call        the business phones the booker (booker's phone)
 *   they_call      the booker phones the business (`value` = number)
 *   their_address  at the booker's address (asked at booking)
 */
export type BookingLocationType =
  | "video_link"
  | "google_meet"
  | "in_person"
  | "we_call"
  | "they_call"
  | "their_address";

export interface BookingLocation {
  type: BookingLocationType;
  /** in_person: the address; they_call: the number to call. Otherwise null. */
  value: string | null;
}

/** Extra question on the booking form, on top of name/email/phone. */
export interface IntakeField {
  /** Stable across edits; used as the field name and answer key. */
  id: string;
  label: string;
  type: "text" | "textarea" | "select";
  required: boolean;
  /** Required for "select". Rendered verbatim. */
  options: string[] | null;
}

/**
 * Any host on a page puts it in team mode: availability is the union of
 * hosts' free time and each booking goes to the least-loaded free host
 * (stamped on the event's `assignedToUid`/`assignedToName`).
 */
export interface BookingHost {
  /** uid of an active sub-account member. */
  uid: string;
  /** `displayName` snapshot, refreshed from the member doc on every save. */
  name: string;
  /**
   * Per-host override of `page.workingHours` (part-timers, days off).
   * Absent/empty = inherit the page hours. Team mode only.
   */
  workingHours?: WorkingHour[];
}

/**
 * PayPal.me deposit. The slot holds in `awaiting_payment` until the operator
 * marks it paid (PayPal.me has no webhook); unpaid holds auto-cancel after
 * `holdHours`. Uses the sub-account's `paypalConfig.username`.
 */
export interface BookingPayment {
  /** Major units (dollars, not cents). */
  amount: number;
  /** ISO 4217, same set as quotes/invoices. */
  currency: string;
  /** Shown on the public page, e.g. "Consultation deposit". */
  description: string | null;
  /** Default 24. */
  holdHours: number;
}

export interface BookingPage {
  id: string;
  /** Lower-case kebab-case, unique per sub-account. */
  slug: string;
  name: string;
  /** Markdown above the slot picker. */
  description: string;
  status: BookingPageStatus;

  durationMinutes: number;
  /** Gap between back-to-back meetings. 0 allowed. */
  bufferMinutes: number;
  workingHours: WorkingHour[];
  /** IANA timezone, e.g. "Australia/Sydney". */
  timezone: string;
  /** Bookable days ahead of now. Default 14. */
  visibleDays: number;
  /** Default 2. */
  minNoticeHours: number;
  /** null = unlimited. */
  maxPerDay: number | null;

  intakeFields: IntakeField[];

  /** Non-empty = team mode, see {@link BookingHost}. Empty/absent = one shared
   *  schedule and no host stamped on events. */
  hosts?: BookingHost[];
  /**
   * Team mode only: lets the customer pick a named host. When off, the
   * availability API must never expose staff names.
   */
  allowHostSelection?: boolean;

  /** Overrides `subAccount.logoUrl`. */
  logoUrl: string | null;
  /** Hex. */
  accentColor: string | null;
  /**
   * Preset shared with checkout pages (`lib/checkout/themes.ts`). null keeps
   * the default brand look. `accentColor` still beats the preset's accent.
   */
  themePreset?: CheckoutThemeId | null;

  /**
   * One static video-call URL for every booking on this page. Snapshotted onto
   * each event, used as the .ics LOCATION and the "Join" CTA in emails.
   * null/undefined = in person or sent separately.
   */
  meetingUrl?: string | null;
  /**
   * Create a unique Google Meet link per booking on the calendar the booking
   * is pushed to (see `bookingCalendarOwnerUid`). Falls back to `meetingUrl`
   * when that calendar isn't connected or Google fails. Absent = off.
   */
  googleMeet?: boolean;
  /**
   * Where the meeting happens. Required to publish a new or edited page.
   * Absent on older pages: read via `effectiveBookingLocation()`, which
   * derives Google Meet / video link from the two fields above.
   */
  location?: BookingLocation | null;

  /** Markdown shown after a successful booking. */
  confirmationMessage: string;
  /**
   * Post-booking redirect, free bookings only (payment holds never redirect,
   * so the PayPal CTA stays visible). null/undefined = stay on the
   * confirmation panel.
   */
  redirectUrl?: string | null;
  /**
   * Append `booking_id` + `email` to the redirect for conversion tracking.
   * Turn off to keep the booker's email out of the destination's logs and
   * referrers. Undefined reads as true.
   */
  redirectAppendParams?: boolean;
  /** Email reminders. */
  remindersEnabled: boolean;
  /**
   * Text confirmation at booking plus a text at each reminder offset, from the
   * sub-account's Twilio sender. Absent = off (texts cost money).
   */
  smsRemindersEnabled?: boolean;
  /** Minutes before the event, shared by email and text reminders. */
  reminderOffsetsMinutes: number[];

  payment: BookingPayment | null;

  /** Defaults to "global" so nothing is ever untagged, even with scoping off.
   *  Booking pages are in the scoping-enable backfill list. */
  territoryId: string;
  /**
   * Territory for contacts created through this page, e.g. a regional office
   * page. null = the normal inbound-lead default (Global).
   */
  defaultTerritoryId: string | null;

  agencyId: string;
  subAccountId: string;
  createdByUid: string;
  createdAt: Timestamp | FieldValue | null;
  updatedAt: Timestamp | FieldValue | null;
}

/** Editable fields. Tenancy and timestamps are server-stamped. */
export type BookingPageFormData = Pick<
  BookingPage,
  | "slug"
  | "name"
  | "description"
  | "status"
  | "durationMinutes"
  | "bufferMinutes"
  | "workingHours"
  | "timezone"
  | "visibleDays"
  | "minNoticeHours"
  | "maxPerDay"
  | "intakeFields"
  | "hosts"
  | "allowHostSelection"
  | "logoUrl"
  | "accentColor"
  | "themePreset"
  | "meetingUrl"
  | "googleMeet"
  | "location"
  | "confirmationMessage"
  | "redirectUrl"
  | "redirectAppendParams"
  | "remindersEnabled"
  | "smsRemindersEnabled"
  | "reminderOffsetsMinutes"
  | "payment"
  | "defaultTerritoryId"
>;

export const DEFAULT_REMINDER_OFFSETS_MINUTES: readonly number[] = [
  1440, // T-24h
  60, // T-1h
];

export const DEFAULT_VISIBLE_DAYS = 14;

export const DEFAULT_MIN_NOTICE_HOURS = 2;

export const DEFAULT_PAYMENT_HOLD_HOURS = 24;
