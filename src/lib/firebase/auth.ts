import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
  EmailAuthProvider,
  reauthenticateWithCredential,
  updatePassword,
  type User,
} from "firebase/auth";
import { getFirebaseAuth } from "./client";

export async function signInWithEmail(email: string, password: string) {
  const credential = await signInWithEmailAndPassword(
    getFirebaseAuth(),
    email,
    password,
  );
  await createSessionCookie(credential.user);
  return credential;
}

export async function signUpWithEmail(email: string, password: string) {
  const credential = await createUserWithEmailAndPassword(
    getFirebaseAuth(),
    email,
    password,
  );
  await createSessionCookie(credential.user);
  return credential;
}

export async function signOutUser() {
  await fetch("/api/logout", { method: "GET" }).catch((err) =>
    console.warn("logout endpoint failed", err),
  );
  return signOut(getFirebaseAuth());
}

/** Firebase doesn't reveal whether the address exists (anti-enumeration), so the UI should show the same message either way. */
export async function sendPasswordReset(email: string): Promise<void> {
  await sendPasswordResetEmail(getFirebaseAuth(), email);
}

/**
 * Re-authenticates with the current password first, so a stale session gets
 * a clear auth/wrong-password instead of auth/requires-recent-login.
 */
export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const auth = getFirebaseAuth();
  const user = auth.currentUser;
  if (!user || !user.email) {
    throw new Error("Not signed in.");
  }
  const credential = EmailAuthProvider.credential(user.email, currentPassword);
  await reauthenticateWithCredential(user, credential);
  await updatePassword(user, newPassword);
}

/** ID token -> the __session cookie next-firebase-auth-edge checks on protected routes. */
async function createSessionCookie(user: User): Promise<void> {
  const idToken = await user.getIdToken();
  const res = await fetch("/api/login", {
    method: "GET",
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (!res.ok) {
    throw new Error(
      `Session cookie request failed: ${res.status} ${res.statusText}`,
    );
  }
}
