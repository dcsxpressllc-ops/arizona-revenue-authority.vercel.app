import "server-only";

import { createHash } from "node:crypto";
import { FieldValue, type Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import type { ApiKeyMode } from "@/types/api";

/**
 * Idempotency cache for POST/PATCH/DELETE carrying an Idempotency-Key, kept 24h.
 *
 *   miss -> run the handler and store {status, body}
 *   hit, same fingerprint -> replay the stored response
 *   hit, different fingerprint -> 409 idempotency_error (never silently re-run
 *   a different body under the same key)
 *
 * Stored at `subAccounts/{id}/apiIdempotency/{mode}_{keyId}_{sha(key)}`.
 * Namespaced by mode so test can never replay live. The caller's key is hashed
 * to keep it out of doc ids. Server-only; rules deny clients.
 *
 * Expiry is checked lazily on read; the daily api-cleanup cron deletes expired
 * docs (no Firestore TTL policy needed).
 */

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_KEY_LEN = 255;
const VALID_KEY_RE = /^[A-Za-z0-9_\-:.]+$/;

export interface CachedResponse {
  status: number;
  bodyJson: unknown;
  /** SHA-256 of the request payload, to catch the same key reused with a different body. */
  requestFingerprint: string;
  createdAt: Date;
  expiresAt: Date;
}

export function fingerprintRequest(method: string, path: string, rawBody: string): string {
  return createHash("sha256")
    .update(`${method.toUpperCase()} ${path}\n${rawBody}`, "utf8")
    .digest("hex");
}

function docIdFor(mode: ApiKeyMode, keyId: string, idempotencyKey: string): string {
  const keyHash = createHash("sha256")
    .update(idempotencyKey, "utf8")
    .digest("hex");
  return `${mode}_${keyId}_${keyHash}`;
}

export function isValidIdempotencyKey(key: string): boolean {
  if (key.length < 1 || key.length > MAX_KEY_LEN) return false;
  return VALID_KEY_RE.test(key);
}

function tsToDate(ts: Timestamp | Date | null | undefined): Date | null {
  if (!ts) return null;
  if (ts instanceof Date) return ts;
  if (typeof (ts as Timestamp).toDate === "function") {
    return (ts as Timestamp).toDate();
  }
  return null;
}

export async function readIdempotencyCache(
  subAccountId: string,
  mode: ApiKeyMode,
  keyId: string,
  idempotencyKey: string,
): Promise<CachedResponse | null> {
  const ref = getAdminDb()
    .collection("subAccounts")
    .doc(subAccountId)
    .collection("apiIdempotency")
    .doc(docIdFor(mode, keyId, idempotencyKey));
  const snap = await ref.get();
  if (!snap.exists) return null;
  const data = snap.data()!;
  const expiresAt = tsToDate(data.expiresAt);
  if (!expiresAt || expiresAt.getTime() <= Date.now()) {
    // Expired counts as a miss. The daily api-cleanup cron deletes it later.
    return null;
  }
  return {
    status: data.status as number,
    bodyJson: data.bodyJson,
    requestFingerprint: data.requestFingerprint as string,
    createdAt: tsToDate(data.createdAt) ?? new Date(0),
    expiresAt,
  };
}

export async function writeIdempotencyCache(
  subAccountId: string,
  mode: ApiKeyMode,
  keyId: string,
  idempotencyKey: string,
  entry: { status: number; bodyJson: unknown; requestFingerprint: string },
): Promise<void> {
  const ref = getAdminDb()
    .collection("subAccounts")
    .doc(subAccountId)
    .collection("apiIdempotency")
    .doc(docIdFor(mode, keyId, idempotencyKey));
  const expiresAt = new Date(Date.now() + CACHE_TTL_MS);
  await ref.set({
    status: entry.status,
    bodyJson: entry.bodyJson,
    requestFingerprint: entry.requestFingerprint,
    mode,
    createdAt: FieldValue.serverTimestamp(),
    expiresAt,
  });
}
