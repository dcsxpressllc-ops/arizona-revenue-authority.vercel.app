/**
 * Two separate reasons an SMS can be blocked:
 *   smsOptedOut                  carrier STOP, written only by the Twilio inbound
 *                                webhook. Twilio keeps its own suppression list,
 *                                so only an inbound START clears it.
 *   smsConsent.consented false   declined on a form. Our own block; lifted if
 *                                they consent later.
 * No consent record at all (imports, manual entry, forms without a box) is sendable.
 *
 * Senders check this one gate so the two can't get conflated again; writing
 * smsOptedOut for a declined checkbox would fake an irreversible STOP.
 */

export interface SmsBlockCheckInput {
  smsOptedOut?: boolean;
  smsConsent?: { consented?: boolean } | null;
}

export type SmsBlockReason = "carrier_stop" | "consent_declined";

/** Why this contact can't be texted, or null if sendable. */
export function smsSendBlock(
  contact: SmsBlockCheckInput,
): SmsBlockReason | null {
  if (contact.smsOptedOut === true) return "carrier_stop";
  if (contact.smsConsent?.consented === false) return "consent_declined";
  return null;
}
