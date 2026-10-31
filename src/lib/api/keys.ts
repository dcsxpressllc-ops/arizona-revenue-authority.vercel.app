import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ApiKeyMode } from "@/types/api";

/**
 * Key format: `lsk_<mode>_<prefix>_<secret>`
 *   lsk_     vendor namespace, so leaked keys are easy to grep and secret-scan
 *   mode     `live` or `test`, visible in any log line
 *   prefix   8 Crockford-base32 chars; indexed for lookup, safe to display
 *   secret   32 Crockford-base32 chars (~160 bits)
 *
 * The raw key is shown once at creation. Firestore stores only the SHA-256 hex.
 */

// Crockford base32 (no 0/O, 1/I/L, U) so keys survive being read aloud.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const PREFIX_LEN = 8;
const SECRET_LEN = 32;

function randomBase32(length: number): string {
  // 32 is a power of 2, so mod-ing random bytes has no bias.
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += ALPHABET[bytes[i]! % 32];
  }
  return out;
}

export interface MintedApiKey {
  /** Show once, never persist. */
  rawKey: string;
  prefix: string;
  hashedSecret: string;
}

export function mintApiKey(mode: ApiKeyMode): MintedApiKey {
  const prefix = randomBase32(PREFIX_LEN);
  const secret = randomBase32(SECRET_LEN);
  const rawKey = `lsk_${mode}_${prefix}_${secret}`;
  return { rawKey, prefix, hashedSecret: hashApiKey(rawKey) };
}

export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey, "utf8").digest("hex");
}

export interface ParsedApiKey {
  mode: ApiKeyMode;
  prefix: string;
}

const KEY_RE = new RegExp(
  `^lsk_(live|test)_([${ALPHABET}]{${PREFIX_LEN}})_[${ALPHABET}]{${SECRET_LEN}}$`,
);

/**
 * Format check only, so the middleware can reject junk without touching
 * Firestore. Callers still look up by prefix and constant-time-compare the hash.
 */
export function parseApiKey(rawKey: string): ParsedApiKey | null {
  const match = KEY_RE.exec(rawKey);
  if (!match) return null;
  return { mode: match[1] as ApiKeyMode, prefix: match[2]! };
}

/**
 * Run before the lastUsedAt write so timing can't reveal which keys exist.
 * timingSafeEqual throws on length mismatch, so callers pass SHA-256 hex (always 64 chars).
 */
export function safeEqualHash(expectedHex: string, actualHex: string): boolean {
  if (expectedHex.length !== actualHex.length) return false;
  return timingSafeEqual(
    Buffer.from(expectedHex, "utf8"),
    Buffer.from(actualHex, "utf8"),
  );
}

/**
 * Keeps namespace, mode and prefix so the key is identifiable, drops the secret:
 *   lsk_live_AB12CD34_<secret>  ->  lsk_live_AB12CD34_***
 *   anything else               ->  ***redacted***
 */
export function redactApiKey(rawKey: string): string {
  const parsed = parseApiKey(rawKey);
  if (!parsed) return "***redacted***";
  return `lsk_${parsed.mode}_${parsed.prefix}_***`;
}
