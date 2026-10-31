import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * HMAC tokens for Web Voice, signed with AUTOMATIONS_TOKEN_SECRET (rotating it
 * just hides open widgets' mics until reload).
 *
 *  - Widget token (`w1.`): minted by the origin-checked /api/web-chat/config,
 *    passed to the iframe, required by /api/web-chat/voice/start. Only keeps
 *    casual callers out (Origin can be faked); the real limits are the daily
 *    minute and concurrency caps.
 *  - Session token (`s1.`): minted by /voice/start for one chat session +
 *    grant. Sent to ElevenLabs as custom-LLM extra body so the reply endpoint
 *    knows which session a turn belongs to. A visitor can only get one for their
 *    own session.
 */

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function secret(): string | null {
  const s = process.env.AUTOMATIONS_TOKEN_SECRET;
  return s && s.length >= 16 ? s : null;
}

function sign(payload: string): string | null {
  const s = secret();
  if (!s) return null;
  return createHmac("sha256", s).update(payload).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** 12h, longer than any realistic page view. */
const WIDGET_TTL_MS = 12 * 60 * 60 * 1000;
/** Covers the 15-min signed-URL window plus the longest call. */
const SESSION_TTL_MS = 60 * 60 * 1000;

export function issueWidgetToken(subAccountId: string): string | null {
  if (!ID_RE.test(subAccountId)) return null;
  const exp = Date.now() + WIDGET_TTL_MS;
  const payload = `w1.${subAccountId}.${exp}`;
  const sig = sign(`web-voice-widget|${payload}`);
  return sig ? `${payload}.${sig}` : null;
}

export function verifyWidgetToken(token: unknown, subAccountId: string): boolean {
  if (typeof token !== "string") return false;
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "w1") return false;
  const [, sa, expStr, sig] = parts;
  if (sa !== subAccountId) return false;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = sign(`web-voice-widget|w1.${sa}.${expStr}`);
  return !!expected && safeEqual(sig, expected);
}

export interface SessionTokenClaims {
  subAccountId: string;
  sessionId: string;
  grantId: string;
}

export function issueSessionToken(claims: SessionTokenClaims): string | null {
  if (
    !ID_RE.test(claims.subAccountId) ||
    !ID_RE.test(claims.sessionId) ||
    !ID_RE.test(claims.grantId)
  ) {
    return null;
  }
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = `s1.${claims.subAccountId}.${claims.sessionId}.${claims.grantId}.${exp}`;
  const sig = sign(`web-voice-session|${payload}`);
  return sig ? `${payload}.${sig}` : null;
}

export function verifySessionToken(token: unknown): SessionTokenClaims | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 6 || parts[0] !== "s1") return null;
  const [, subAccountId, sessionId, grantId, expStr, sig] = parts;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return null;
  const expected = sign(
    `web-voice-session|s1.${subAccountId}.${sessionId}.${grantId}.${expStr}`,
  );
  if (!expected || !safeEqual(sig, expected)) return null;
  return { subAccountId, sessionId, grantId };
}
