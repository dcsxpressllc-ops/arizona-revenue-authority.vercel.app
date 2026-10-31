import type { Timestamp, FieldValue } from "firebase/firestore";
import type { ActivityType } from "@/types/contacts";

export type ActivityMeta = {
  dealId?: string;
  fromStageId?: string;
  toStageId?: string;
  bookingId?: string;
  /** Quote lifecycle rows: source quote id and its display number. */
  quoteId?: string;
  quoteNumber?: string;
  /** Territory retag rows. null id means "Global"; moved* counts let the timeline render without re-querying. */
  fromTerritoryId?: string | null;
  toTerritoryId?: string | null;
  movedDeals?: number;
  movedQuotes?: number;
  movedTasks?: number;
  movedEvents?: number;
  /** Booking rows: event and page slug for deep links. payment* only on booking_payment_received. */
  eventId?: string;
  bookingPageSlug?: string;
  paymentAmount?: number;
  paymentCurrency?: string;
  /** Follow-up task minted alongside this row (watchdog, captures). */
  taskId?: string;
  /** Bulk-email rows: parent broadcast. */
  broadcastId?: string;
  /** webinar_* rows: source webinar and registration. */
  webinarId?: string;
  webinarSlug?: string;
  webinarRegistrationId?: string;
  /** webinar_completed: highest watch percentage reached. */
  webinarWatchPercent?: number;
} | null;

export interface ActivityDoc {
  id: string;
  type: ActivityType;
  content: string;
  createdBy: string;
  createdAt: Timestamp | FieldValue | null;
  meta: ActivityMeta;
}
