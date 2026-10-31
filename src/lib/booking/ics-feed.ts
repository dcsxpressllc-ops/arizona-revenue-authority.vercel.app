/**
 * Multi-event ICS feed behind GET /api/sub-accounts/{id}/calendar.ics, for
 * subscribing from Google, Apple or Outlook.
 *
 * Separate from ics.ts (single-event invite) because the feed uses
 * METHOD:PUBLISH, has no ORGANIZER/ATTENDEE, and keeps cancelled events with
 * STATUS:CANCELLED so subscribers drop them on the next poll. CRLF line endings
 * per RFC 5545.
 */

export interface FeedEventInput {
  /** Firestore event id. */
  uid: string;
  /** UTC. */
  startAt: Date;
  /** UTC. */
  endAt: Date;
  /** Event title in the subscriber's calendar. */
  summary: string;
  description?: string;
  /** Meeting URL goes here so Google/Apple render a native join link. */
  location?: string;
  /** Cancelled events stay as STATUS:CANCELLED so subscribers remove them instead of keeping a ghost entry. */
  status: "CONFIRMED" | "CANCELLED" | "TENTATIVE";
  lastModified?: Date;
}

export interface FeedInput {
  /** UID suffix and PRODID host, from NEXT_PUBLIC_APP_URL. */
  domain: string;
  /** Shown in Google Calendar's "Other calendars" list. */
  calendarName: string;
  events: FeedEventInput[];
}

function formatIcsDate(d: Date): string {
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

function escapeIcsText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

function foldLine(line: string): string {
  if (line.length <= 75) return line;
  const out: string[] = [];
  for (let i = 0; i < line.length; i += 73) {
    out.push((i === 0 ? "" : " ") + line.slice(i, i + 73));
  }
  return out.join("\r\n");
}

export function generateIcsFeed(input: FeedInput): string {
  const stampNow = formatIcsDate(new Date());
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//LeadStack//Calendar Feed//${input.domain}//EN`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText(input.calendarName)}`,
    // Google ignores this (polls every 8-24h on its own); Apple respects it.
    "X-PUBLISHED-TTL:PT1H",
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
  ];

  for (const e of input.events) {
    const lastMod = formatIcsDate(e.lastModified ?? new Date());
    lines.push(
      "BEGIN:VEVENT",
      `UID:${e.uid}@${input.domain}`,
      `DTSTAMP:${stampNow}`,
      `DTSTART:${formatIcsDate(e.startAt)}`,
      `DTEND:${formatIcsDate(e.endAt)}`,
      `SUMMARY:${escapeIcsText(e.summary)}`,
      `STATUS:${e.status}`,
      `LAST-MODIFIED:${lastMod}`,
    );
    if (e.description) {
      lines.push(`DESCRIPTION:${escapeIcsText(e.description)}`);
    }
    if (e.location) {
      lines.push(`LOCATION:${escapeIcsText(e.location)}`);
    }
    // A fixed 0 is fine for a feed; clients compare DTSTAMP/LAST-MODIFIED.
    lines.push("SEQUENCE:0", "END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}
