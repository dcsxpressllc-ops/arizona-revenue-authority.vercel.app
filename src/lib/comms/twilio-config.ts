import "server-only";

import { buildTwilioClient } from "./twilio";

/**
 * Dedicated-SMS setup helpers, called from the settings save route. Both
 * return structured results instead of throwing, so a failed webhook step
 * doesn't roll back the save.
 *
 * validateCredentials checks the SID/token against /Accounts/{sid}.
 * autoConfigureInboundWebhook points the number's smsUrl at our inbound
 * endpoint; on failure the UI offers a copy-the-URL fallback.
 */

export interface ValidateCredentialsResult {
  ok: boolean;
  /** Shown in success toasts. */
  friendlyName: string | null;
  error: string | null;
}

export async function validateCredentials(
  accountSid: string,
  authToken: string,
): Promise<ValidateCredentialsResult> {
  if (!accountSid || !authToken) {
    return { ok: false, friendlyName: null, error: "Missing SID or token." };
  }
  try {
    const client = buildTwilioClient(accountSid, authToken);
    const account = await client.api.v2010.accounts(accountSid).fetch();
    return {
      ok: true,
      friendlyName: account.friendlyName ?? null,
      error: null,
    };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Twilio rejected the credentials.";
    return { ok: false, friendlyName: null, error: message };
  }
}

export interface AutoConfigureWebhookResult {
  ok: boolean;
  error: string | null;
}

// The IncomingPhoneNumbers list accepts `phoneNumber=` (E.164) and returns 0
// or 1 results per account.
export async function autoConfigureInboundWebhook({
  accountSid,
  authToken,
  fromNumber,
  webhookUrl,
}: {
  accountSid: string;
  authToken: string;
  fromNumber: string;
  webhookUrl: string;
}): Promise<AutoConfigureWebhookResult> {
  try {
    const client = buildTwilioClient(accountSid, authToken);
    const list = await client.incomingPhoneNumbers.list({
      phoneNumber: fromNumber,
      limit: 1,
    });
    if (list.length === 0) {
      return {
        ok: false,
        error: `Twilio account doesn't own the number ${fromNumber}. Buy / port it first, or paste the number exactly as Twilio shows it (E.164, e.g. +15551234567).`,
      };
    }
    const phone = list[0];
    await client.incomingPhoneNumbers(phone.sid).update({
      smsUrl: webhookUrl,
      smsMethod: "POST",
    });
    return { ok: true, error: null };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : "Twilio rejected the webhook configuration.";
    return { ok: false, error: message };
  }
}

export interface ConfigureVoiceWebhookResult {
  ok: boolean;
  error: string | null;
  /**
   * The number's Voice URL before we overwrote it (null if none), so disabling
   * can restore it instead of clobbering manual forwarding. Undefined if we
   * failed before reading the number.
   */
  prevVoiceUrl?: string | null;
}

/**
 * Point the number's voiceUrl at the Missed Call Text Back handler, returning
 * the old URL so disable can restore it. This is the only place we touch a
 * number's Voice URL, and only on explicit opt-in. Failure is reported so the
 * UI can offer a manual fallback.
 */
export async function configureVoiceWebhook({
  accountSid,
  authToken,
  fromNumber,
  webhookUrl,
}: {
  accountSid: string;
  authToken: string;
  fromNumber: string;
  webhookUrl: string;
}): Promise<ConfigureVoiceWebhookResult> {
  try {
    const client = buildTwilioClient(accountSid, authToken);
    const list = await client.incomingPhoneNumbers.list({
      phoneNumber: fromNumber,
      limit: 1,
    });
    if (list.length === 0) {
      return {
        ok: false,
        error: `Twilio account doesn't own the number ${fromNumber}.`,
      };
    }
    const phone = list[0];
    // Twilio returns "" for an unset URL; store null.
    const prevVoiceUrl = phone.voiceUrl ? phone.voiceUrl : null;
    await client.incomingPhoneNumbers(phone.sid).update({
      voiceUrl: webhookUrl,
      voiceMethod: "POST",
    });
    return { ok: true, error: null, prevVoiceUrl };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : "Twilio rejected the voice webhook configuration.";
    return { ok: false, error: message };
  }
}

/**
 * Restore the Voice URL captured at enable time, or clear it with null.
 * Best-effort: the config flips off regardless, and worst case the operator
 * clears it in Twilio.
 */
export async function restoreVoiceWebhook({
  accountSid,
  authToken,
  fromNumber,
  prevVoiceUrl,
}: {
  accountSid: string;
  authToken: string;
  fromNumber: string;
  prevVoiceUrl: string | null;
}): Promise<AutoConfigureWebhookResult> {
  try {
    const client = buildTwilioClient(accountSid, authToken);
    const list = await client.incomingPhoneNumbers.list({
      phoneNumber: fromNumber,
      limit: 1,
    });
    if (list.length === 0) {
      return { ok: false, error: `Twilio account doesn't own ${fromNumber}.` };
    }
    await client.incomingPhoneNumbers(list[0].sid).update({
      // "" clears the field on Twilio's side.
      voiceUrl: prevVoiceUrl ?? "",
      voiceMethod: "POST",
    });
    return { ok: true, error: null };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : "Twilio rejected the voice webhook restore.";
    return { ok: false, error: message };
  }
}
