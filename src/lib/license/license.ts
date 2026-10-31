import "server-only";

import { FieldValue, type Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";

/**
 * Provisional-license window. For its first 14 days (from the first
 * attributable heartbeat, see lib/gitpage/heartbeat) a deployment is
 * provisional and the template vendor can flag the license invalid via the
 * heartbeat response, which locks the dashboard. After 14 days without a revocation it's permanently validated
 * and the flag is never honored again. Backs the compliance check in the
 * Terms while keeping ownership guaranteed for validated deployments.
 *
 * Fails open: no heartbeat response, a Firestore error or no `system/license`
 * doc all mean "not revoked". State lives in `system/license` (server-only).
 */

const WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export type LicenseState = "provisional" | "validated";
export type LicenseDirective = "ok" | "revoked";

interface LicenseDocData {
  provisionalSince?: Timestamp;
  validatedAt?: Timestamp | null;
  revoked?: boolean;
}

function licenseRef() {
  return getAdminDb().doc("system/license");
}

// 60s in-memory cache so the dashboard guard doesn't read Firestore on every
// navigation; at worst a lock/unlock lands a minute late.
let cachedRevoked: { value: boolean; at: number } | null = null;
const CACHE_MS = 60 * 1000;

function bustCache(): void {
  cachedRevoked = null;
}

/**
 * Creates the anchor on first call and returns the state. Heartbeat path
 * only; the read guards never write. A revoked deployment can't become
 * validated until an "ok" directive clears the flag.
 */
export async function ensureLicenseAnchor(): Promise<LicenseState> {
  const ref = licenseRef();
  const snap = await ref.get();
  const data = (snap.exists ? snap.data() : undefined) as
    | LicenseDocData
    | undefined;

  if (!data?.provisionalSince) {
    await ref.set(
      { provisionalSince: FieldValue.serverTimestamp(), revoked: false },
      { merge: true },
    );
    return "provisional";
  }
  if (data.validatedAt) return "validated";
  if (data.revoked === true) return "provisional";

  if (Date.now() - data.provisionalSince.toMillis() >= WINDOW_MS) {
    await ref.set(
      { validatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    return "validated";
  }
  return "provisional";
}

/**
 * Applies the heartbeat's license directive. No-op once validated; writes
 * only on transitions. "ok" clears a prior revocation so a mistaken flag
 * recovers on the next heartbeat.
 */
export async function applyLicenseDirective(
  directive: LicenseDirective,
): Promise<void> {
  const ref = licenseRef();
  const snap = await ref.get();
  const data = (snap.exists ? snap.data() : undefined) as
    | LicenseDocData
    | undefined;
  if (data?.validatedAt) return;
  const currentlyRevoked = data?.revoked === true;

  if (directive === "revoked" && !currentlyRevoked) {
    await ref.set(
      { revoked: true, revokedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    bustCache();
  } else if (directive === "ok" && currentlyRevoked) {
    await ref.set(
      { revoked: false, restoredAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    bustCache();
  }
}

/** Layout guard. Never throws or writes; errors read as "not revoked". */
export async function isLicenseRevoked(): Promise<boolean> {
  if (cachedRevoked && Date.now() - cachedRevoked.at < CACHE_MS) {
    return cachedRevoked.value;
  }
  try {
    const snap = await licenseRef().get();
    const data = (snap.exists ? snap.data() : undefined) as
      | LicenseDocData
      | undefined;
    const value = data?.revoked === true && !data?.validatedAt;
    cachedRevoked = { value, at: Date.now() };
    return value;
  } catch {
    return false;
  }
}
