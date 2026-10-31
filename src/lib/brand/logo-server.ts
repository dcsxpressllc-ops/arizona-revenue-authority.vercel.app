import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  LOGO_MAX_BYTES,
  LOGO_MAX_EDGE,
  LOGO_ROUTE_PREFIX,
  type LogoMime,
} from "@/lib/brand/logo-shared";

/**
 * Uploaded logos live as base64 in server-only docs (both paths are deny-all
 * in the rules) and are served by the public /api/brand/logo route. The
 * existing `logoUrl` field then points at that route, so every consumer keeps
 * working unchanged.
 */

export type LogoScope = "agency" | "sa";

export function logoDocRef(scope: LogoScope, id: string) {
  const db = getAdminDb();
  return scope === "agency"
    ? db.doc(`agencies/${id}/brandAssets/logo`)
    : db.doc(`subAccounts/${id}/private/brandLogo`);
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function isWebp(buf: Buffer): boolean {
  return (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  );
}

/** Checks the bytes match the claimed type and fit the budget. Returns the buffer or a problem string. */
export function validateLogo(base64: unknown, mime: unknown): Buffer | string {
  if (mime !== "image/png" && mime !== "image/webp") {
    return "Logo must be a PNG or WebP";
  }
  if (typeof base64 !== "string" || base64.length === 0) {
    return "Missing logo data";
  }
  if (base64.length > LOGO_MAX_BYTES * 1.4) {
    return "Logo is too large. Try a simpler image.";
  }
  const buf = Buffer.from(base64, "base64");
  if (buf.length === 0 || buf.length > LOGO_MAX_BYTES) {
    return "Logo is too large. Try a simpler image.";
  }
  if (mime === "image/png") {
    if (buf.length < 24 || !PNG_SIGNATURE.every((b, i) => buf[i] === b)) {
      return "Logo data isn't a PNG";
    }
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    // Small slack over the client resize target.
    if (!width || !height || width > LOGO_MAX_EDGE * 2 || height > LOGO_MAX_EDGE * 2) {
      return "Logo dimensions are out of range";
    }
  } else if (!isWebp(buf)) {
    return "Logo data isn't a WebP";
  }
  return buf;
}

/** Absolute so the URL works inside emails and PDFs, not just the app. */
export function logoPublicUrl(
  scope: LogoScope,
  id: string,
  version: number,
  request: Request,
): string {
  const base =
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ||
    new URL(request.url).origin;
  return `${base}${LOGO_ROUTE_PREFIX}${scope}/${encodeURIComponent(id)}?v=${version}`;
}

export async function storeLogo(
  scope: LogoScope,
  id: string,
  buf: Buffer,
  mime: LogoMime,
): Promise<number> {
  const version = Date.now();
  await logoDocRef(scope, id).set({
    data: buf.toString("base64"),
    mime,
    bytes: buf.length,
    version,
    updatedAt: FieldValue.serverTimestamp(),
  });
  return version;
}
