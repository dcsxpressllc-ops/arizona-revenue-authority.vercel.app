import "server-only";

import { generateIcs } from "@/lib/booking/ics";

/** Host used for ICS UIDs and PRODID, from NEXT_PUBLIC_APP_URL. */
export function icsDomain(): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL?.replace(/^https?:\/\//, "")
      ?.replace(/\/.*$/, "")
      ?.toLowerCase() ?? "leadstack.dev"
  );
}

/** Confirmation-email invite. UID = event id so a reschedule updates it instead of duplicating. */
export function buildBookingIcsAttachment(params: {
  eventId: string;
  startAt: Date;
  endAt: Date;
  domain: string;
  title: string;
  description: string;
  location: string;
  organizerEmail?: string;
  organizerName?: string;
  attendeeEmail: string;
  attendeeName: string;
}): { filename: string; content: string } {
  const ics = generateIcs({
    uid: params.eventId,
    domain: params.domain,
    startAt: params.startAt,
    endAt: params.endAt,
    summary: params.title,
    description: params.description,
    location: params.location,
    organizerEmail: params.organizerEmail,
    organizerName: params.organizerName,
    attendeeEmail: params.attendeeEmail,
    attendeeName: params.attendeeName,
    method: "REQUEST",
    status: "CONFIRMED",
    sequence: 0,
  });
  // Resend attachments[].content is base64.
  const content = Buffer.from(ics, "utf-8").toString("base64");
  return { filename: "invite.ics", content };
}
