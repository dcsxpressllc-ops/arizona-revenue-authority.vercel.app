import "server-only";

import { cookies } from "next/headers";
import { FieldValue } from "firebase-admin/firestore";
import {
  MEMBER_SESSION_COOKIE,
  MEMBER_SESSION_MAX_AGE_SECONDS,
  verifyMemberSessionToken,
} from "@/lib/community/member-auth";
import { getAdminDb } from "@/lib/firebase/admin";
import type { Member } from "@/types/community";

/**
 * Verifies the member session cookie and loads the member. null if missing,
 * invalid, expired, removed, or scoped to a different sub-account; that scope
 * check is what stops one tenant's session being replayed against another's.
 * Server-only.
 */
export async function getCurrentMember(
  subAccountId: string,
): Promise<Member | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(MEMBER_SESSION_COOKIE)?.value;
  if (!token) return null;

  const verified = verifyMemberSessionToken(token);
  if (!verified || verified.subAccountId !== subAccountId) return null;

  const ref = getAdminDb()
    .doc(`subAccounts/${subAccountId}/members/${verified.memberId}`);
  const snap = await ref.get();
  if (!snap.exists) return null;

  const data = snap.data() as Omit<Member, "id">;
  if (data.status !== "active") return null;

  // Best-effort "last active"; never blocks the read.
  void ref
    .set({ lastSeenAt: FieldValue.serverTimestamp() }, { merge: true })
    .catch(() => {});

  return { id: snap.id, ...data };
}

export async function setMemberSessionCookie(token: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(MEMBER_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: MEMBER_SESSION_MAX_AGE_SECONDS,
  });
}

export async function clearMemberSessionCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(MEMBER_SESSION_COOKIE);
}
