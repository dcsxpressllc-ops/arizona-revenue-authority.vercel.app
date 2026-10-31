import { notFound } from "next/navigation";

import { getAdminDb } from "@/lib/firebase/admin";
import {
  hashEventToken,
  verifyEventToken,
} from "@/lib/booking/event-token";
import { PublicEventView } from "@/components/booking/public-event-view";
import { eventStatus } from "@/types/events";
import type { BookingPage } from "@/types/booking";
import type { CalendarEvent } from "@/types/events";
import type { SubAccountDoc } from "@/types/tenancy";

export const dynamic = "force-dynamic";

/**
 * Public event-management page: attendee can view, reschedule or cancel
 * without logging in. The HMAC token is verified, then its hash must match the
 * event's publicTokenHash (rescheduling rotates it). Any mismatch 404s.
 */

interface PageProps {
  params: Promise<{ token: string }>;
}

export default async function PublicEventPage({ params }: PageProps) {
  const { token } = await params;

  const verified = verifyEventToken(token);
  if (!verified) notFound();

  const db = getAdminDb();
  const eventSnap = await db.collection("events").doc(verified.eventId).get();
  if (!eventSnap.exists) notFound();
  const event = eventSnap.data() as CalendarEvent;
  if (event.publicTokenHash !== hashEventToken(token)) notFound();
  if (!event.bookingPageSlug) notFound();

  const [subSnap, pageSnap] = await Promise.all([
    db.doc(`subAccounts/${event.subAccountId}`).get(),
    db
      .doc(
        `subAccounts/${event.subAccountId}/bookingPages/${event.bookingPageSlug}`,
      )
      .get(),
  ]);
  if (!subSnap.exists) notFound();
  const sub = subSnap.data() as SubAccountDoc;
  const page = (pageSnap.exists ? pageSnap.data() : null) as BookingPage | null;

  const startAt = (
    event.startAt as { toDate?: () => Date } | null
  )?.toDate?.();
  const endAt = (
    event.endAt as { toDate?: () => Date } | null
  )?.toDate?.();
  if (!startAt || !endAt) notFound();

  const branding = {
    name: sub.name ?? "Booking",
    logoUrl: page?.logoUrl ?? sub.logoUrl ?? null,
    accentColor: page?.accentColor ?? null,
  };

  return (
    <PublicEventView
      token={token}
      subAccountId={event.subAccountId}
      eventId={event.id}
      status={eventStatus(event)}
      title={event.title ?? "Meeting"}
      pageName={page?.name ?? event.title ?? "Meeting"}
      pageSlug={event.bookingPageSlug}
      bookingPageStatus={page?.status ?? "published"}
      timezone={page?.timezone ?? "UTC"}
      durationMinutes={page?.durationMinutes ?? 30}
      location={event.location || null}
      // Editable from the calendar too, so only real web links become a button.
      meetingUrl={
        event.meetingUrl && /^https?:\/\//i.test(event.meetingUrl)
          ? event.meetingUrl
          : null
      }
      startAt={startAt.toISOString()}
      endAt={endAt.toISOString()}
      paymentLinkUrl={event.paymentLinkUrl ?? null}
      paymentAmount={event.paymentAmount ?? null}
      paymentCurrency={event.paymentCurrency ?? null}
      // Card deposit needs the agency gate on AND a Stripe connection that can
      // confirm payments; otherwise a paid slot could stay held.
      cardPayEnabled={
        (sub as { paymentsEnabledByAgency?: boolean })
          .paymentsEnabledByAgency === true &&
        (sub as { stripeConnectionMeta?: { ready?: boolean } | null })
          .stripeConnectionMeta?.ready === true
      }
      branding={branding}
    />
  );
}
