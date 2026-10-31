import "server-only";

import { randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { APP_VERSION } from "@/config/version";
import {
  applyLicenseDirective,
  ensureLicenseAnchor,
  type LicenseDirective,
  type LicenseState,
} from "@/lib/license/license";

/**
 * Liveness ping to gitpage. The response says whether the owner has an active
 * gitpage Agency subscription and is cached in `system/gitpageStatus` so the
 * website builder can show "subscribe to enable builds" without another call.
 *
 * Called from instrumentation.ts (each cold start) and
 * /api/cron/gitpage-heartbeat (daily).
 */

const HEARTBEAT_URL_PATH = "/api/v1/leadstack/heartbeat";
const HEARTBEAT_TIMEOUT_MS = 5000;

interface HeartbeatPayload {
  instanceId: string;
  ownerEmail: string;
  version: string;
  subAccountCount?: number;
  buildsLastDay?: number;
  hasGitpageKey: boolean;
  platform?: string;
  firstBoot?: boolean;
  /** See lib/license/license.ts. */
  licenseState?: LicenseState;
}

interface HeartbeatResponse {
  ok: boolean;
  gitpageStatus: { agency: boolean };
}

interface HeartbeatStats {
  subAccountCount?: number;
  buildsLastDay?: number;
}

function getBaseUrl(): string {
  return (
    process.env.GITPAGE_API_URL?.replace(/\/$/, "") ?? "https://www.gitpage.site"
  );
}

/** Independent of GITPAGE_API_URL, so pointing gitpage elsewhere never redirects this report. */
function getMothershipUrl(): string | null {
  const raw =
    process.env.MOTHERSHIP_API_URL?.replace(/\/$/, "") ?? "https://leadstack.dev";
  return raw || null;
}

/**
 * Returns the license directive from the status response, if any. Best-effort: never affects the gitpage heartbeat or boot, and a bad
 * response means "no directive" (license layer fails open).
 */
async function reportToMothership(
  body: HeartbeatPayload,
): Promise<LicenseDirective | null> {
  const base = getMothershipUrl();
  if (!base) return null;
  try {
    const res = await fetch(`${base}${HEARTBEAT_URL_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const parsed = (await res.json()) as { license?: { status?: unknown } };
    const status = parsed.license?.status;
    return status === "revoked" || status === "ok" ? status : null;
  } catch (err) {
    console.warn("[mothership/heartbeat] report failed", err);
    return null;
  }
}

function detectPlatform(): string {
  if (process.env.VERCEL) return "vercel";
  if (process.env.RENDER) return "render";
  if (process.env.RAILWAY_PROJECT_ID) return "railway";
  if (process.env.FLY_APP_NAME) return "fly";
  return "self-hosted";
}

/** Stable instanceId at `system/heartbeat`, so gitpage's `leadstack_instances` keeps this deployment as one row. */
async function getOrCreateInstanceId(): Promise<{
  id: string;
  firstBoot: boolean;
}> {
  const db = getAdminDb();
  const ref = db.doc("system/heartbeat");
  const snap = await ref.get();
  const existing = snap.exists ? (snap.data()?.instanceId as string | undefined) : undefined;
  if (existing) {
    return { id: existing, firstBoot: false };
  }
  const id = randomUUID();
  await ref.set(
    { instanceId: id, createdAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
  return { id, firstBoot: true };
}

/** Owner email from Firestore, else BOOTSTRAP_ADMIN_EMAIL (same address before first signup). */
async function resolveOwnerEmail(): Promise<string | null> {
  const db = getAdminDb();
  try {
    const config = await db.doc("appConfig/main").get();
    const ownerUid = config.data()?.firstAgencyOwnerUid as string | undefined;
    if (ownerUid) {
      const userDoc = await db.doc(`users/${ownerUid}`).get();
      const email = userDoc.data()?.email as string | undefined;
      if (email) return email;
    }
  } catch {
    // fall through to env fallback
  }
  return process.env.BOOTSTRAP_ADMIN_EMAIL?.trim() || null;
}

/**
 * Stats are optional: the boot heartbeat omits them, the daily cron sends
 * them. Never throws; returns the response so the cron can cache it.
 */
export async function sendHeartbeat(
  stats: HeartbeatStats = {},
): Promise<HeartbeatResponse | null> {
  const telemetryOff = process.env.GITPAGE_TELEMETRY === "off";

  let instance: { id: string; firstBoot: boolean };
  try {
    instance = await getOrCreateInstanceId();
  } catch (err) {
    console.warn("[gitpage/heartbeat] getOrCreateInstanceId failed", err);
    return null;
  }

  const ownerEmail = await resolveOwnerEmail();
  if (!ownerEmail) {
    // No owner yet. The first boot after signup sends it, and the license
    // window anchor below waits for an owner too.
    return null;
  }

  // License check disclosed in the Terms.
  let licenseState: LicenseState | null = null;
  try {
    licenseState = await ensureLicenseAnchor();
  } catch (err) {
    console.warn("[license] ensureLicenseAnchor failed", err);
  }
  if (telemetryOff && licenseState !== "provisional") return null;

  const body: HeartbeatPayload = {
    instanceId: instance.id,
    ownerEmail,
    version: APP_VERSION,
    hasGitpageKey: Boolean(process.env.GITPAGE_API_KEY?.trim()),
    platform: detectPlatform(),
    firstBoot: instance.firstBoot,
    ...(licenseState ? { licenseState } : {}),
    ...(stats.subAccountCount !== undefined
      ? { subAccountCount: stats.subAccountCount }
      : {}),
    ...(stats.buildsLastDay !== undefined
      ? { buildsLastDay: stats.buildsLastDay }
      : {}),
  };

  // Swallows its own errors and doesn't affect the gitpage
  // flow; a license directive is only applied while the window is open.
  const directive = await reportToMothership(body);
  if (directive) {
    try {
      await applyLicenseDirective(directive);
    } catch (err) {
      console.warn("[license] applyLicenseDirective failed", err);
    }
  }

  if (telemetryOff) return null;

  let res: Response;
  try {
    res = await fetch(`${getBaseUrl()}${HEARTBEAT_URL_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS),
    });
  } catch (err) {
    console.warn("[gitpage/heartbeat] fetch failed", err);
    return null;
  }

  if (!res.ok) {
    console.warn("[gitpage/heartbeat] non-2xx", res.status);
    return null;
  }

  let parsed: HeartbeatResponse;
  try {
    parsed = (await res.json()) as HeartbeatResponse;
  } catch {
    return null;
  }

  // Cache the agency flag so the UI doesn't re-ping gitpage per page load.
  // `agencyFalseSince` is set on the true -> false edge so the UI can tell a
  // fresh "needs subscription" from one that lapsed days ago.
  try {
    const db = getAdminDb();
    const ref = db.doc("system/gitpageStatus");
    const prev = await ref.get();
    const prevData = prev.exists ? prev.data() : undefined;
    const prevAgency = prevData?.agency === true;
    const newAgency = parsed.gitpageStatus?.agency === true;

    const update: Record<string, unknown> = {
      agency: newAgency,
      hasApiKey: Boolean(process.env.GITPAGE_API_KEY?.trim()),
      lastCheckedAt: FieldValue.serverTimestamp(),
      lastError: null,
    };
    if (newAgency) {
      update.agencyFalseSince = null;
    } else if (!prevAgency || !prevData?.agencyFalseSince) {
      // First false (or first heartbeat ever).
      update.agencyFalseSince = FieldValue.serverTimestamp();
    }
    // Still false: keep the original agencyFalseSince.

    await ref.set(update, { merge: true });
  } catch (err) {
    console.warn("[gitpage/heartbeat] failed to cache status", err);
  }

  return parsed;
}

/**
 * A build POST just got a 202, which proves the key is valid and the
 * subscription active. The heartbeat can be wrong about the subscription (it
 * checks our owner email, which may differ from the gitpage account's), so
 * record the success.
 */
export async function markGitpageBuildSucceeded(): Promise<void> {
  try {
    const db = getAdminDb();
    // Only lastBuildAcceptedAt and lastError. `agency`/`agencyFalseSince` belong
    // to the heartbeat and the next cron overwrites them anyway; the hook treats
    // a recent build as authoritative over both.
    await db.doc("system/gitpageStatus").set(
      {
        hasApiKey: Boolean(process.env.GITPAGE_API_KEY?.trim()),
        lastError: null,
        lastBuildAcceptedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  } catch (err) {
    console.warn("[gitpage/heartbeat] markGitpageBuildSucceeded failed", err);
  }
}

/**
 * Build call got a 401. The heartbeat checks subscription, not key validity,
 * so it likely still says agency: true; flag it so the operator re-pastes the key.
 */
export async function markGitpageKeyInvalid(): Promise<void> {
  try {
    const db = getAdminDb();
    const ref = db.doc("system/gitpageStatus");
    const prev = await ref.get();
    const update: Record<string, unknown> = {
      agency: false,
      lastError: "401_invalid_api_key",
      lastCheckedAt: FieldValue.serverTimestamp(),
    };
    if (!prev.exists || !prev.data()?.agencyFalseSince) {
      update.agencyFalseSince = FieldValue.serverTimestamp();
    }
    await ref.set(update, { merge: true });
  } catch (err) {
    console.warn("[gitpage/heartbeat] markGitpageKeyInvalid failed", err);
  }
}

/** Daily heartbeat stats. Keep the queries cheap. */
export async function collectHeartbeatStats(): Promise<HeartbeatStats> {
  const db = getAdminDb();
  const stats: HeartbeatStats = {};

  try {
    const subCount = await db.collection("subAccounts").count().get();
    stats.subAccountCount = subCount.data().count;
  } catch {
    // leave undefined
  }

  try {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const builds = await db
      .collectionGroup("website")
      .where("lastBuildAt", ">", dayAgo)
      .count()
      .get();
    stats.buildsLastDay = builds.data().count;
  } catch {
    // collectionGroup queries on `website` may need an index; leave
    // undefined if it errors.
  }

  return stats;
}
