import "server-only";

import twilio from "twilio";
import { getAdminDb } from "@/lib/firebase/admin";
import type { DialerPrivateDoc, SubAccountDoc } from "@/types";

/**
 * Server helpers for the outbound browser dialer, on the sub-account's own
 * Twilio account (same creds as SMS). Provisioning creates an API Key and a
 * TwiML App there; the browser gets a short-lived AccessToken (never the
 * secrets) and dials through the TwiML App, which hits our TwiML webhook.
 * Outbound only: the number's inbound voice handler (Vapi BYOC / MCTB) is never touched.
 */

const PRIVATE_DOC = "dialer";

export function dialerEnabled(
  sub?: Pick<SubAccountDoc, "dialerConfig"> | null,
): boolean {
  return sub?.dialerConfig?.enabled === true;
}

export function dialerPrivateRef(subAccountId: string) {
  return getAdminDb().doc(`subAccounts/${subAccountId}/private/${PRIVATE_DOC}`);
}

export async function getDialerPrivate(
  subAccountId: string,
): Promise<DialerPrivateDoc | null> {
  const snap = await dialerPrivateRef(subAccountId).get();
  if (!snap.exists) return null;
  const data = snap.data() as Partial<DialerPrivateDoc>;
  if (!data.apiKeySid || !data.apiKeySecret || !data.twimlAppSid) return null;
  return data as DialerPrivateDoc;
}

/** TwiML App voice URL. */
export function dialerTwimlUrl(subAccountId: string): string {
  return `${process.env.NEXT_PUBLIC_APP_URL}/api/webhooks/twilio/dialer/twiml/${subAccountId}`;
}

/** <Dial action> callback with the call outcome. */
export function dialerStatusUrl(
  subAccountId: string,
  contactId: string,
): string {
  return `${process.env.NEXT_PUBLIC_APP_URL}/api/webhooks/twilio/dialer/status/${subAccountId}?contactId=${encodeURIComponent(contactId)}`;
}

/**
 * Same URL reconstruction as the SMS/WhatsApp inbound routes, but keeps the
 * query string: the status callback carries `?contactId=...` and Twilio signs
 * the full URL.
 */
export function validateDialerSignature(input: {
  request: Request;
  authToken: string;
  params: Record<string, string>;
}): boolean {
  const { request, authToken, params } = input;
  const signature = request.headers.get("x-twilio-signature");
  if (!signature) return false;
  const proto = request.headers.get("x-forwarded-proto") ?? "https";
  const host =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const url = new URL(request.url);
  const fullUrl = `${proto}://${host ?? url.host}${url.pathname}${url.search}`;
  return twilio.validateRequest(authToken, signature, fullUrl, params);
}

/** JWT for the browser Device. 1h TTL; identity is the uid. */
export function mintDialerToken(input: {
  accountSid: string;
  apiKeySid: string;
  apiKeySecret: string;
  twimlAppSid: string;
  identity: string;
}): string {
  const AccessToken = twilio.jwt.AccessToken;
  const token = new AccessToken(
    input.accountSid,
    input.apiKeySid,
    input.apiKeySecret,
    { identity: input.identity, ttl: 3600 },
  );
  token.addGrant(
    new AccessToken.VoiceGrant({
      outgoingApplicationSid: input.twimlAppSid,
      incomingAllow: false,
    }),
  );
  return token.toJwt();
}

/** Deterministic so the status callback can update the same row. */
export function dialerActivityId(callSid: string): string {
  return `dialer_${callSid}`;
}

/** "client:abc123" to "abc123"; anything else null. */
export function uidFromClientAddress(from: string | undefined): string | null {
  if (!from) return null;
  return from.startsWith("client:") ? from.slice("client:".length) : null;
}

export function formatCallDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
