import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import {
  calendarConnectionRef,
  calendarPrivateRef,
  exchangeCodeForTokens,
  googleCalendarConfigured,
  googleRedirectUri,
  verifyCalendarState,
} from "@/lib/google/calendar";

/**
 * Shared OAuth callback for Google Calendar connect:
 * GET /api/google/callback?code=...&state=...
 *
 * Google needs one exact redirect URI per deployment, so the sub-account and
 * member uid ride in the HMAC-signed `state`. The uid binding means tokens
 * only land on the connection of whoever completed consent.
 *
 * Session-protected (not in PUBLIC_PATHS) so middleware attaches x-user-uid,
 * same as the Meta callback. Verifies state first, then membership, then
 * exchanges the code and writes the token doc (deny-all) and the status doc
 * (member-readable). Always redirects to Settings with `?gcal=...`.
 */

function appBase(request: Request): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL ?? new URL(request.url).origin
  ).replace(/\/$/, "");
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const declined = url.searchParams.get("error");

  if (!state) {
    return NextResponse.redirect(
      new URL("/agency/sub-accounts?gcal=bad_state", appBase(request)),
    );
  }
  const verified = verifyCalendarState(state);
  if (!verified) {
    return NextResponse.redirect(
      new URL("/agency/sub-accounts?gcal=bad_state", appBase(request)),
    );
  }
  const { subAccountId: id, uid: stateUid } = verified;

  // state is HMAC-authenticated; the caller must also be an active member and
  // the same person who started the flow.
  const access = await requireSubAccountMember(request, id);
  if (access instanceof NextResponse) return access;

  const settingsUrl = new URL(`/sa/${id}/dashboard/settings`, appBase(request));
  const finish = (status: string) => {
    settingsUrl.searchParams.set("gcal", status);
    return NextResponse.redirect(settingsUrl);
  };

  if (access.uid !== stateUid) {
    return finish("bad_state");
  }
  if (declined || !code) {
    return finish("cancelled");
  }
  if (!googleCalendarConfigured()) {
    return finish("not_configured");
  }
  const redirectUri = googleRedirectUri();
  if (!redirectUri) {
    return finish("not_configured");
  }

  try {
    const tokens = await exchangeCodeForTokens(code, redirectUri);

    const db = getAdminDb();
    const batch = db.batch();
    batch.set(calendarPrivateRef(id, access.uid), {
      refreshToken: tokens.refreshToken,
      accessToken: tokens.accessToken,
      accessTokenExpiresAt: tokens.expiresAtMs,
      googleEmail: tokens.email,
      calendarId: "primary",
      grantedScopes: tokens.grantedScopes,
      connectedAt: FieldValue.serverTimestamp(),
    });
    batch.set(calendarConnectionRef(id, access.uid), {
      uid: access.uid,
      provider: "google",
      googleEmail: tokens.email,
      status: "connected",
      errorReason: null,
      connectedAt: FieldValue.serverTimestamp(),
      lastSyncAt: null,
      updatedAt: FieldValue.serverTimestamp(),
    });
    await batch.commit();

    return finish("connected");
  } catch (err) {
    console.error(`[google/callback] connect failed sa=${id}`, err);
    return finish("error");
  }
}
