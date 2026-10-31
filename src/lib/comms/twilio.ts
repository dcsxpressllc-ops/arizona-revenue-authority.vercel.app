import "server-only";

import twilio, { type Twilio } from "twilio";
import { getAdminDb } from "@/lib/firebase/admin";
import { agencyAllowsSharedSms } from "@/lib/agency/policy";
import { segmentInfo } from "@/lib/comms/sms-segments";
import { checkQuota, recordUsage } from "@/lib/server/usage-meter";
import type { SubAccountDoc, TwilioConfig } from "@/types";
import { runAfterResponse } from "@/lib/server/after-response";

/**
 * Twilio client resolution, two modes side by side:
 *   shared (default)   TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER
 *   dedicated (opt-in) `twilioConfig.enabled === true` on the sub-account; sends
 *                      use its stored creds and inbound routes to its number
 *
 * getTwilioForSubAccount picks the right { client, fromNumber, mode }, falling
 * back to shared. Toggling dedicated mode is fully reversible.
 */

let _envClient: Twilio | null = null;
const _saClientCache = new Map<string, Twilio>();

export type TwilioMode = "shared" | "dedicated";

export interface ResolvedTwilio {
  client: Twilio;
  fromNumber: string;
  mode: TwilioMode;
  /** Dedicated mode only; used for inbound signature checks. */
  authToken: string;
  accountSid: string;
}

function getEnvTwilio(): Twilio {
  if (!_envClient) {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !token) {
      throw new Error(
        "TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are not set. Add them to .env.local to enable shared-mode SMS, or configure a dedicated number on the sub-account.",
      );
    }
    _envClient = twilio(sid, token);
  }
  return _envClient;
}

/** Shared mode only. Dedicated is checked by `subAccountTwilioIsConfigured`. */
export function smsIsConfigured(): boolean {
  // trim() so a blank env var (stray space or newline) doesn't count as
  // configured, matching the health check.
  return (
    !!process.env.TWILIO_ACCOUNT_SID?.trim() &&
    !!process.env.TWILIO_AUTH_TOKEN?.trim() &&
    !!process.env.TWILIO_FROM_NUMBER?.trim()
  );
}

export function subAccountTwilioIsConfigured(
  cfg: TwilioConfig | null | undefined,
): boolean {
  return !!cfg?.enabled && !!cfg.accountSid && !!cfg.authToken && !!cfg.fromNumber;
}

/**
 * WhatsApp uses the dedicated Twilio creds plus a `whatsappFromNumber`, so it
 * needs both. No shared env fallback; it's per sub-account only.
 */
export function subAccountWhatsappIsConfigured(
  cfg: TwilioConfig | null | undefined,
): boolean {
  return (
    !!cfg?.enabled &&
    !!cfg.accountSid &&
    !!cfg.authToken &&
    !!cfg.whatsappFromNumber
  );
}

/** Normalise to `whatsapp:+E164`. Idempotent. */
export function toWhatsappAddress(numberOrAddress: string): string {
  const bare = numberOrAddress.startsWith("whatsapp:")
    ? numberOrAddress.slice("whatsapp:".length)
    : numberOrAddress;
  return `whatsapp:${bare.trim()}`;
}

/** Twilio prefixes inbound From/To with `whatsapp:`. */
export function stripWhatsappPrefix(address: string): string {
  return address.startsWith("whatsapp:")
    ? address.slice("whatsapp:".length)
    : address;
}

/**
 * Does another sub-account already claim `number`? Inbound webhooks resolve
 * the sub-account with exactly this query (sender equality + enabled, limit 1,
 * no agency filter), so a second claim would silently steal the first's
 * inbound routing. Same query shape, so no new index. Returns the holder's
 * name (or id) for the error, or null when free.
 */
export async function findDedicatedNumberHolder(opts: {
  field: "fromNumber" | "whatsappFromNumber";
  number: string;
  excludeSubAccountId: string;
}): Promise<string | null> {
  // limit(2): the excluded sub-account may match itself, and one more row is
  // enough to spot another claimant.
  const snap = await getAdminDb()
    .collection("subAccounts")
    .where(`twilioConfig.${opts.field}`, "==", opts.number)
    .where("twilioConfig.enabled", "==", true)
    .limit(2)
    .get();
  const holder = snap.docs.find((d) => d.id !== opts.excludeSubAccountId);
  if (!holder) return null;
  return (holder.data().name as string) || holder.id;
}

/** Uncached client for ad-hoc calls, e.g. validating creds the operator just typed. */
export function buildTwilioClient(accountSid: string, authToken: string): Twilio {
  return twilio(accountSid, authToken);
}

/**
 * Right Twilio client for a sub-account. Pass the doc if you already have it
 * to skip a read. Throws when neither mode is configured.
 */
export async function getTwilioForSubAccount(
  subAccountId: string,
  subAccount?: SubAccountDoc | null,
): Promise<ResolvedTwilio> {
  let cfg = subAccount?.twilioConfig ?? null;
  let agencyId = subAccount?.agencyId ?? null;
  if (!subAccount) {
    const data = (
      await getAdminDb().doc(`subAccounts/${subAccountId}`).get()
    ).data() as SubAccountDoc | undefined;
    cfg = data?.twilioConfig ?? null;
    agencyId = data?.agencyId ?? null;
  }

  if (subAccountTwilioIsConfigured(cfg) && cfg) {
    let client = _saClientCache.get(subAccountId);
    if (!client) {
      client = twilio(cfg.accountSid, cfg.authToken);
      _saClientCache.set(subAccountId, client);
    }
    return {
      client,
      fromNumber: cfg.fromNumber,
      mode: "dedicated",
      authToken: cfg.authToken,
      accountSid: cfg.accountSid,
    };
  }

  // No dedicated number: shared sender only if the agency still allows it.
  // Otherwise the sub-account must bring its own number.
  if (!(await agencyAllowsSharedSms(agencyId))) {
    throw new Error(
      "Shared SMS is disabled by your agency. Configure a dedicated Twilio number for this sub-account (Settings → SMS) to send.",
    );
  }

  if (!smsIsConfigured()) {
    throw new Error(
      "SMS is not configured. Either set TWILIO_* env vars (shared mode) or enable a dedicated number on the sub-account.",
    );
  }

  return {
    client: getEnvTwilio(),
    fromNumber: process.env.TWILIO_FROM_NUMBER!,
    mode: "shared",
    authToken: process.env.TWILIO_AUTH_TOKEN!,
    accountSid: process.env.TWILIO_ACCOUNT_SID!,
  };
}

/** Call after creds rotate or dedicated mode is disabled. */
export function invalidateSubAccountTwilioCache(subAccountId: string): void {
  _saClientCache.delete(subAccountId);
}

/**
 * Twilio 21610, "Attempt to send to unsubscribed recipient": the carrier says
 * this number texted STOP. Authoritative even when our `smsOptedOut` is false
 * (e.g. STOP sent before the number hit our webhook), so callers can record
 * the opt-out instead of losing it in a generic error.
 */
export class SmsRecipientUnsubscribedError extends Error {
  readonly to: string;
  constructor(to: string) {
    super(
      "Recipient has unsubscribed at the carrier (Twilio 21610). They must text START to opt back in.",
    );
    this.name = "SmsRecipientUnsubscribedError";
    this.to = to;
  }
}

/** Use this over the legacy `sendSms`; falls back to shared mode automatically. */
export async function sendSmsForSubAccount({
  subAccountId,
  subAccount,
  to,
  body,
}: {
  subAccountId: string;
  subAccount?: SubAccountDoc | null;
  to: string;
  body: string;
}): Promise<{ sid: string; mode: TwilioMode; from: string }> {
  // Quota check before spend (fails open), segments metered after a successful
  // create. Every SMS sender goes through here, so this covers them all.
  const quota = await checkQuota({ subAccountId, unit: "smsSegments", subAccount });
  if (!quota.allowed && quota.error) throw quota.error;
  const resolved = await getTwilioForSubAccount(subAccountId, subAccount);
  try {
    const msg = await resolved.client.messages.create({
      from: resolved.fromNumber,
      to,
      body,
    });
    runAfterResponse(() => recordUsage({
      subAccountId,
      unit: "smsSegments",
      qty: segmentInfo(body).segments,
      subAccount,
      // Only the shared sender is on the agency's Twilio bill, so only it is billable.
      also: resolved.mode === "shared" ? ["smsSegmentsShared"] : [],
    }));
    return { sid: msg.sid, mode: resolved.mode, from: resolved.fromNumber };
  } catch (err) {
    if ((err as { code?: number })?.code === 21610) {
      throw new SmsRecipientUnsubscribedError(to);
    }
    throw err;
  }
}

/**
 * WhatsApp over the dedicated Twilio client, from `whatsappFromNumber` with
 * `whatsapp:` addresses. No shared fallback; throws if not configured.
 * The 24h session-window check is the caller's job, since callers have the
 * last-inbound timestamp.
 */
export async function sendWhatsappForSubAccount({
  subAccountId,
  subAccount,
  to,
  body,
}: {
  subAccountId: string;
  subAccount?: SubAccountDoc | null;
  to: string;
  body: string;
}): Promise<{ sid: string; from: string }> {
  let cfg = subAccount?.twilioConfig ?? null;
  if (!subAccount) {
    const snap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
    cfg = (snap.data() as SubAccountDoc | undefined)?.twilioConfig ?? null;
  }
  if (!subAccountWhatsappIsConfigured(cfg) || !cfg?.whatsappFromNumber) {
    throw new Error(
      "WhatsApp is not configured for this sub-account. Set a WhatsApp sender number under Settings → SMS.",
    );
  }
  const waQuota = await checkQuota({
    subAccountId,
    unit: "whatsappMessages",
    subAccount,
  });
  if (!waQuota.allowed && waQuota.error) throw waQuota.error;
  // cfg.enabled was checked above, so this is the dedicated client.
  const resolved = await getTwilioForSubAccount(subAccountId, subAccount);
  const from = toWhatsappAddress(cfg.whatsappFromNumber);
  const msg = await resolved.client.messages.create({
    from,
    to: toWhatsappAddress(to),
    body,
  });
  runAfterResponse(() => recordUsage({
    subAccountId,
    unit: "whatsappMessages",
    qty: 1,
    subAccount,
  }));
  return { sid: msg.sid, from };
}

/**
 * Send an approved WhatsApp template (`contentSid` + positional values), the
 * only compliant way to message outside the 24h window. `contentVariables[0]`
 * fills {{1}}, and so on. Callers resolve merge tags and confirm approval.
 */
export async function sendWhatsappTemplateForSubAccount({
  subAccountId,
  subAccount,
  to,
  contentSid,
  contentVariables,
}: {
  subAccountId: string;
  subAccount?: SubAccountDoc | null;
  to: string;
  contentSid: string;
  contentVariables: string[];
}): Promise<{ sid: string; from: string }> {
  let cfg = subAccount?.twilioConfig ?? null;
  if (!subAccount) {
    const snap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
    cfg = (snap.data() as SubAccountDoc | undefined)?.twilioConfig ?? null;
  }
  if (!subAccountWhatsappIsConfigured(cfg) || !cfg?.whatsappFromNumber) {
    throw new Error(
      "WhatsApp is not configured for this sub-account. Set a WhatsApp sender number under Settings → SMS.",
    );
  }
  const tplQuota = await checkQuota({
    subAccountId,
    unit: "whatsappMessages",
    subAccount,
  });
  if (!tplQuota.allowed && tplQuota.error) throw tplQuota.error;
  const resolved = await getTwilioForSubAccount(subAccountId, subAccount);
  const from = toWhatsappAddress(cfg.whatsappFromNumber);
  // Twilio wants a JSON map keyed by string indices.
  const varMap: Record<string, string> = {};
  contentVariables.forEach((v, i) => {
    varMap[String(i + 1)] = v;
  });
  const msg = await resolved.client.messages.create({
    from,
    to: toWhatsappAddress(to),
    contentSid,
    contentVariables: JSON.stringify(varMap),
  });
  runAfterResponse(() => recordUsage({
    subAccountId,
    unit: "whatsappMessages",
    qty: 1,
    subAccount,
  }));
  return { sid: msg.sid, from };
}

/** Legacy env-only send for old callers. New code should use `sendSmsForSubAccount`. */
export async function sendSms({
  to,
  body,
}: {
  to: string;
  body: string;
}): Promise<{ sid: string }> {
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!from) {
    throw new Error("TWILIO_FROM_NUMBER is not set.");
  }
  const client = getEnvTwilio();
  const msg = await client.messages.create({ from, to, body });
  return { sid: msg.sid };
}
