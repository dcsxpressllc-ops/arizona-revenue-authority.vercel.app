import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { agencyAllowsSharedSms } from "@/lib/agency/policy";
import { smsSendBlock } from "@/lib/comms/sms-consent";
import {
  sendSmsForSubAccount,
  smsIsConfigured,
  subAccountTwilioIsConfigured,
  SmsRecipientUnsubscribedError,
} from "@/lib/comms/twilio";
import { formatStartLocal } from "@/lib/booking/email";
import type { Contact } from "@/types/contacts";
import type { SubAccountDoc } from "@/types/tenancy";

/**
 * Booking confirmation and reminder texts. Same sender rules as the workflow
 * send_sms step: the sub-account's own Twilio number, else the shared sender
 * when the agency allows it. Never throws; a failed text never breaks a booking.
 */

export type BookingSmsResult =
  | { sent: true }
  | { sent: false; reason: string };

export function bookingConfirmationSmsBody(input: {
  recipientName: string;
  businessName: string;
  pageName: string;
  startAt: Date;
  timezone: string;
  meetingUrl: string | null;
  /** Where it happens (address, phone call…); absent = video or not set. */
  location?: string | null;
  publicEventUrl: string;
}): string {
  const first = input.recipientName.trim().split(/\s+/)[0];
  return [
    `${first ? `Hi ${first}, you're` : "You're"} booked: ${input.pageName} with ${input.businessName}, ${formatStartLocal(input.startAt, input.timezone)}.`,
    input.meetingUrl ? `Join: ${input.meetingUrl}` : null,
    input.location ? `Where: ${input.location}` : null,
    `Reschedule or cancel: ${input.publicEventUrl}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function bookingReminderSmsBody(input: {
  businessName: string;
  pageName: string;
  startAt: Date;
  timezone: string;
  meetingUrl: string | null;
  location?: string | null;
  publicEventUrl: string;
}): string {
  return [
    `Reminder: ${input.pageName} with ${input.businessName}, ${formatStartLocal(input.startAt, input.timezone)}.`,
    input.meetingUrl ? `Join: ${input.meetingUrl}` : null,
    input.location ? `Where: ${input.location}` : null,
    `Reschedule or cancel: ${input.publicEventUrl}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function sendBookingSms(input: {
  subAccountId: string;
  sub: SubAccountDoc;
  contactId: string;
  body: string;
  /** Activity label, e.g. "Booking confirmation". */
  label: string;
}): Promise<BookingSmsResult> {
  const db = getAdminDb();
  let contact: Contact | null = null;
  try {
    const snap = await db.doc(`contacts/${input.contactId}`).get();
    contact = snap.exists ? (snap.data() as Contact) : null;
  } catch (err) {
    console.warn("[booking/sms] contact read failed", err);
  }
  if (!contact) return { sent: false, reason: "no_contact" };
  if (smsSendBlock(contact)) return { sent: false, reason: "opted_out" };
  const to = contact.phone;
  if (!to) return { sent: false, reason: "no_phone" };

  const hasSms =
    subAccountTwilioIsConfigured(input.sub.twilioConfig) ||
    (smsIsConfigured() && (await agencyAllowsSharedSms(input.sub.agencyId)));
  if (!hasSms) return { sent: false, reason: "sms_not_configured" };

  try {
    const sent = await sendSmsForSubAccount({
      subAccountId: input.subAccountId,
      subAccount: input.sub,
      to,
      body: input.body,
    });
    const contactRef = db.collection("contacts").doc(input.contactId);
    try {
      await contactRef.collection("activities").add({
        type: "sms_sent",
        content: `SMS (${input.label}): ${input.body.length > 80 ? `${input.body.slice(0, 80)}…` : input.body}`,
        createdBy: "booking",
        meta: { sid: sent.sid, mode: sent.mode },
        createdAt: FieldValue.serverTimestamp(),
      });
    } catch (err) {
      console.warn("[booking/sms] activity write failed", err);
    }
    // Thread rows only in dedicated mode, where replies route back to us.
    if (sent.mode === "dedicated") {
      try {
        await contactRef.collection("messages").doc(sent.sid).set({
          agencyId: input.sub.agencyId,
          subAccountId: input.subAccountId,
          contactId: input.contactId,
          direction: "outbound",
          status: "sent",
          body: input.body,
          from: sent.from,
          to,
          twilioMessageSid: sent.sid,
          sentByUid: "booking",
          error: null,
          readAt: null,
          createdAt: FieldValue.serverTimestamp(),
        });
        const { upsertConversationForMessage } = await import(
          "@/lib/server/conversations-service"
        );
        await upsertConversationForMessage({
          contactId: input.contactId,
          subAccountId: input.subAccountId,
          agencyId: input.sub.agencyId,
          contactName: contact.name ?? "",
          contactPhone: to,
          channel: "sms",
          direction: "outbound",
          body: input.body,
          pauseBot: false,
        });
      } catch (err) {
        console.warn("[booking/sms] thread/inbox write failed", err);
      }
    }
    return { sent: true };
  } catch (err) {
    if (err instanceof SmsRecipientUnsubscribedError) {
      // The carrier's STOP is authoritative; record it so later sends are blocked.
      try {
        await db.doc(`contacts/${input.contactId}`).update({
          smsOptedOut: true,
          updatedAt: FieldValue.serverTimestamp(),
        });
      } catch (recordErr) {
        console.warn("[booking/sms] opt-out record failed", recordErr);
      }
      return { sent: false, reason: "carrier_unsubscribed" };
    }
    console.warn("[booking/sms] send failed", err);
    return { sent: false, reason: "send_failed" };
  }
}
