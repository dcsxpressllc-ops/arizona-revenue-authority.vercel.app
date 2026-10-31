// Review-request constants shared by the server dispatcher and the client UI.

/** Pre-filled SMS body. Tags: {{firstName}} / {{businessName}} / {{reviewUrl}}. */
export const DEFAULT_REVIEW_SMS_TEMPLATE =
  "Hi {{firstName}}, thanks for choosing {{businessName}}! If you have a moment, a quick Google review would mean a lot: {{reviewUrl}}";

export const DEFAULT_REVIEW_COOLDOWN_DAYS = 90;

/**
 * "sms": free-form SMS. "whatsapp_template": approved template, works outside
 * the 24h window (needed for auto-sends). "whatsapp_manual": free-form WhatsApp,
 * only while the customer's 24h window is open; best from the inbox.
 */
export type ReviewChannel = "sms" | "whatsapp_template" | "whatsapp_manual";

/** Also maps the old two-option "whatsapp" value. */
export function normalizeReviewChannel(
  raw: string | null | undefined,
): ReviewChannel {
  if (raw === "sms" || raw === "whatsapp_template" || raw === "whatsapp_manual") {
    return raw;
  }
  if (raw === "whatsapp") return "whatsapp_template"; // legacy value
  return "sms";
}

export function isWhatsappReviewChannel(ch: ReviewChannel): boolean {
  return ch === "whatsapp_template" || ch === "whatsapp_manual";
}
