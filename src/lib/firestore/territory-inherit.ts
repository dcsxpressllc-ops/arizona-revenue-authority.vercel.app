import { doc, getDoc } from "firebase/firestore";
import { getFirebaseDb } from "@/lib/firebase/client";

/**
 * Territory a deal/task/event inherits from its contact, or null (no contact,
 * missing, untagged). Contacts own territory; children copy it at create and
 * follow re-tags. One place so every client create path behaves the same.
 */
export async function territoryIdForContact(
  contactId: string | null | undefined,
): Promise<string | null> {
  if (!contactId) return null;
  try {
    const snap = await getDoc(doc(getFirebaseDb(), "contacts", contactId));
    return (snap.data()?.territoryId as string | null | undefined) ?? null;
  } catch {
    return null;
  }
}
