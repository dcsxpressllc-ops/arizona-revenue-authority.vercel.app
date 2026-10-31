import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Invite-link tokens: `${inviteId}.${HMAC-SHA256("invite.<id>", SECRET)}`.
 *
 * Matching a pending invite on email alone would let anyone who knows the
 * invitee's email sign up first and take the role. The token only travels in
 * the invite link, so presenting it proves the caller got that link.
 *
 * Deterministic and unstored, so re-sending or copying the link never breaks one
 * already in an inbox; revocation still works because signup only accepts live
 * invites. The "invite." prefix stops these verifying as any other token signed
 * with the same secret.
 *
 * Enforced only for invites with `requiresToken: true`. Older invites keep the
 * email-match behavior, and without AUTOMATIONS_TOKEN_SECRET new invites are
 * created without the flag instead of failing.
 */

function getSecret(): string | null {
  const s = process.env.AUTOMATIONS_TOKEN_SECRET;
  return s && s.length >= 16 ? s : null;
}

function sign(inviteId: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`invite.${inviteId}`)
    .digest("hex");
}

export function inviteTokensAvailable(): boolean {
  return getSecret() !== null;
}

/** null when no secret is set. */
export function inviteTokenFor(inviteId: string): string | null {
  const secret = getSecret();
  if (!secret) return null;
  return `${inviteId}.${sign(inviteId, secret)}`;
}

/** Returns the invite id, or null when malformed, forged, or no secret is configured. */
export function verifyInviteToken(token: unknown): string | null {
  const secret = getSecret();
  if (!secret || typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const inviteId = token.slice(0, dot);
  if (!/^[A-Za-z0-9_-]+$/.test(inviteId)) return null;
  const presented = Buffer.from(token.slice(dot + 1), "utf8");
  const expected = Buffer.from(sign(inviteId, secret), "utf8");
  if (presented.length !== expected.length) return null;
  return timingSafeEqual(presented, expected) ? inviteId : null;
}
