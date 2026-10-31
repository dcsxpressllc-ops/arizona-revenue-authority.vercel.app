import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { getFirebaseDb } from "@/lib/firebase/client";
import type { NotificationPrefsDoc } from "@/types/push";

/**
 * Push prefs at `users/{uid}/settings/notifications`: a `subAccounts` map of
 * id -> enabled. Self-scoped rules allow client read/write; the send helper
 * re-checks membership and territory, so a pref can't grant anything.
 * Missing key: members default on, the agency owner defaults off (types/push.ts).
 */

export async function getNotificationPrefs(
  uid: string,
): Promise<NotificationPrefsDoc> {
  const snap = await getDoc(
    doc(getFirebaseDb(), `users/${uid}/settings/notifications`),
  );
  return (snap.data() as NotificationPrefsDoc | undefined) ?? {};
}

export async function setSubAccountNotificationPref(
  uid: string,
  subAccountId: string,
  enabled: boolean,
): Promise<void> {
  await setDoc(
    doc(getFirebaseDb(), `users/${uid}/settings/notifications`),
    {
      subAccounts: { [subAccountId]: enabled },
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );
}
