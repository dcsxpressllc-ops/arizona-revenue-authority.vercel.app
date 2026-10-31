import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import {
  ICON_MAX_BYTES,
  ICON_VARIANTS,
  type IconVariantKey,
} from "@/lib/pwa/icon-variants";

/**
 * Server side of custom app icons. Base64 PNGs in
 * `agencies/{agencyId}/pwaIcons/{variant}` (server-only; /api/pwa/icon serves
 * them). `agency.pwaIconsUpdatedAt` is both the exists flag and the manifest's
 * cache-buster. One agency per deployment, resolved like the landing brand
 * (appConfig/main -> firstAgencyId).
 */

export async function getFirstAgencyId(): Promise<string | null> {
  try {
    const snap = await getAdminDb().doc("appConfig/main").get();
    return snap.exists
      ? ((snap.data()?.firstAgencyId as string | undefined) ?? null)
      : null;
  } catch {
    return null;
  }
}

/** Last upload in ms, or null if none or on any error (callers use the static files). */
export async function getPwaIconVersion(): Promise<number | null> {
  try {
    const agencyId = await getFirstAgencyId();
    if (!agencyId) return null;
    const snap = await getAdminDb().doc(`agencies/${agencyId}`).get();
    const ts = snap.data()?.pwaIconsUpdatedAt as
      | { toMillis?: () => number }
      | null
      | undefined;
    return ts && typeof ts.toMillis === "function" ? ts.toMillis() : null;
  } catch {
    return null;
  }
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Checks it's a PNG with the exact square size (from IHDR, no image library) and fits the doc budget. Returns the buffer or a problem string. */
export function validateIconPng(
  variantKey: IconVariantKey,
  base64: unknown,
): Buffer | string {
  const variant = ICON_VARIANTS.find((v) => v.key === variantKey);
  if (!variant) return "Unknown icon variant";
  if (typeof base64 !== "string" || base64.length === 0) {
    return "Missing icon data";
  }
  // base64 adds ~33%, plus slack for padding.
  if (base64.length > ICON_MAX_BYTES * 1.4) {
    return "Icon is too large — use a simpler image";
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(base64, "base64");
  } catch {
    return "Icon data isn't valid base64";
  }
  if (buf.length > ICON_MAX_BYTES) {
    return "Icon is too large — use a simpler image";
  }
  if (buf.length < 24 || !PNG_SIGNATURE.every((b, i) => buf[i] === b)) {
    return "Icon must be a PNG";
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width !== variant.size || height !== variant.size) {
    return `Icon must be ${variant.size}×${variant.size}`;
  }
  return buf;
}
