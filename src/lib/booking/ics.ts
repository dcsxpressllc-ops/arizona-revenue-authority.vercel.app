/**
 * RFC 5545 invite attached to confirmation emails. Deliberately minimal:
 * METHOD:REQUEST so apps treat it as an invite, UID = event id so a reschedule
 * (higher SEQUENCE) updates rather than duplicates, all times in UTC, no RRULE.
 */

export interface IcsInput {
  /** Firestore event id. */
  uid: string;
  /** UID suffix and PRODID host, from NEXT_PUBLIC_APP_URL. */
  domain: string;
  /** UTC. */
  startAt: Date;
  /** UTC. */
  endAt: Date;
  /** Defaults to CONFIRMED. */
  status?: "CONFIRMED" | "CANCELLED" | "TENTATIVE";
  /** REQUEST for invites, CANCEL on cancel. */
  method?: "REQUEST" | "CANCEL";
  summary: string;
  description?: string;
  /** Free text: phone, video URL, or "We'll send the link separately." */
  location?: string;
  /** Increment on each reschedule. */
  sequence?: number;
  /** Defaults to now. */
  lastModified?: Date;
  /** Optional, but some clients display better with it. */
  organizerEmail?: string;
  organizerName?: string;
  attendeeEmail?: string;
  attendeeName?: string;
}

/** e.g. "19980119T070000Z". */
function formatIcsDate(d: Date): string {
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/** RFC 5545 §3.3.11: escape backslash, semicolon, comma, and newlines. */
function escapeIcsText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** Fold at 75 octets (RFC 5545 §3.1). */
function foldLine(line: string): string {
  if (line.length <= 75) return line;
  const out: string[] = [];
  for (let i = 0; i < line.length; i += 73) {
    out.push((i === 0 ? "" : " ") + line.slice(i, i + 73));
  }
  return out.join("\r\n");
}

export function generateIcs(input: IcsInput): string {
  const status = input.status ?? "CONFIRMED";
  const method = input.method ?? "REQUEST";
  const sequence = input.sequence ?? 0;
  const stampNow = formatIcsDate(input.lastModified ?? new Date());

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//LeadStack//Booking//${input.domain}//EN`,
    "CALSCALE:GREGORIAN",
    `METHOD:${method}`,
    "BEGIN:VEVENT",
    `UID:${input.uid}@${input.domain}`,
    `DTSTAMP:${stampNow}`,
    `DTSTART:${formatIcsDate(input.startAt)}`,
    `DTEND:${formatIcsDate(input.endAt)}`,
    `SUMMARY:${escapeIcsText(input.summary)}`,
    `STATUS:${status}`,
    `SEQUENCE:${sequence}`,
    `LAST-MODIFIED:${stampNow}`,
  ];
  if (input.description) {
    lines.push(`DESCRIPTION:${escapeIcsText(input.description)}`);
  }
  if (input.location) {
    lines.push(`LOCATION:${escapeIcsText(input.location)}`);
  }
  if (input.organizerEmail) {
    const cn = input.organizerName
      ? `;CN=${escapeIcsText(input.organizerName)}`
      : "";
    lines.push(`ORGANIZER${cn}:mailto:${input.organizerEmail}`);
  }
  if (input.attendeeEmail) {
    const cn = input.attendeeName
      ? `;CN=${escapeIcsText(input.attendeeName)}`
      : "";
    lines.push(
      `ATTENDEE${cn};RSVP=TRUE;PARTSTAT=NEEDS-ACTION:mailto:${input.attendeeEmail}`,
    );
  }
  lines.push("END:VEVENT", "END:VCALENDAR");

  // RFC 5545 requires CRLF.
  return lines.map(foldLine).join("\r\n") + "\r\n";
}
