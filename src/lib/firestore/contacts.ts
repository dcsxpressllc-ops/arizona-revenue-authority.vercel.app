import {
  collection,
  doc,
  addDoc,
  updateDoc,
  getDoc,
  limit,
  onSnapshot,
  serverTimestamp,
  query,
  orderBy,
  where,
  type QueryConstraint,
  type Unsubscribe,
} from "firebase/firestore";
import { getFirebaseDb } from "@/lib/firebase/client";
import {
  NOOP_UNSUB,
  territoryQueryPlan,
} from "@/lib/firestore/territory-query";
import type { Contact, ContactFormData, Note } from "@/types/contacts";
import { GLOBAL_TERRITORY_ID, type TenantScope } from "@/types";

const CONTACTS = "contacts";

export interface ContactQueryOptions {
  /** Only contacts whose `territoryId` is in this list; null = no clause. See DealQueryOptions in deals.ts. */
  territoryFilter?: string[] | null;
}

export function subscribeToContacts(
  scope: TenantScope,
  callback: (contacts: Contact[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe;
export function subscribeToContacts(
  scope: TenantScope,
  opts: ContactQueryOptions,
  callback: (contacts: Contact[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe;
export function subscribeToContacts(
  scope: TenantScope,
  callbackOrOpts:
    | ((contacts: Contact[]) => void)
    | ContactQueryOptions,
  callbackOrError?:
    | ((contacts: Contact[]) => void)
    | ((err: Error) => void),
  onErrorMaybe?: (err: Error) => void,
): Unsubscribe {
  const opts: ContactQueryOptions =
    typeof callbackOrOpts === "function" ? {} : callbackOrOpts;
  const callback: (contacts: Contact[]) => void =
    typeof callbackOrOpts === "function"
      ? callbackOrOpts
      : (callbackOrError as (contacts: Contact[]) => void);
  const onError: ((err: Error) => void) | undefined =
    typeof callbackOrOpts === "function"
      ? (callbackOrError as ((err: Error) => void) | undefined)
      : onErrorMaybe;

  // subAccountId filter keeps rules happy; sorting client-side avoids a
  // subAccountId+createdAt composite index.
  const plan = territoryQueryPlan(opts.territoryFilter);
  if (plan.mode === "empty") {
    callback([]);
    return NOOP_UNSUB;
  }
  const constraints: QueryConstraint[] = [
    where("subAccountId", "==", scope.subAccountId),
  ];
  if (plan.mode === "in") constraints.push(plan.constraint);
  const q = query(collection(getFirebaseDb(), CONTACTS), ...constraints);
  return onSnapshot(
    q,
    (snap) => {
      const contacts = snap.docs.map(
        (d) => ({ id: d.id, ...(d.data() as Omit<Contact, "id">) }),
      );
      contacts.sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));
      callback(contacts);
    },
    (err) => onError?.(err),
  );
}

function toMillis(v: unknown): number {
  if (!v) return 0;
  if (v instanceof Date) return v.getTime();
  const maybe = v as { toDate?: () => Date; seconds?: number };
  if (typeof maybe.toDate === "function") return maybe.toDate().getTime();
  if (typeof maybe.seconds === "number") return maybe.seconds * 1000;
  return 0;
}

export async function getContact(id: string): Promise<Contact | null> {
  const snap = await getDoc(doc(getFirebaseDb(), CONTACTS, id));
  if (!snap.exists()) return null;
  return { id: snap.id, ...(snap.data() as Omit<Contact, "id">) };
}

export function subscribeToContact(
  id: string,
  callback: (contact: Contact | null) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  return onSnapshot(
    doc(getFirebaseDb(), CONTACTS, id),
    (snap) => {
      if (!snap.exists()) {
        callback(null);
        return;
      }
      callback({ id: snap.id, ...(snap.data() as Omit<Contact, "id">) });
    },
    (err) => onError?.(err),
  );
}

export async function createContact(
  scope: TenantScope,
  createdByUid: string,
  data: ContactFormData,
): Promise<string> {
  const ref = await addDoc(collection(getFirebaseDb(), CONTACTS), {
    ...data,
    agencyId: scope.agencyId,
    subAccountId: scope.subAccountId,
    createdByUid,
    pipelineStage: null,
    attribution: null,
    emailOptedOut: false,
    smsOptedOut: false,
    // No territory picked: Global (single-territory reps get theirs auto-filled).
    territoryId: data.territoryId ?? GLOBAL_TERRITORY_ID,
    // The public API filters strictly on `mode`, so dashboard contacts must be
    // "live" to show up there. Test docs only come from the API. Contacts without
    // `mode` stay invisible to the API unless backfilled.
    mode: "live",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return ref.id;
}

export async function updateContact(
  id: string,
  data: Partial<ContactFormData>,
): Promise<void> {
  await updateDoc(doc(getFirebaseDb(), CONTACTS, id), {
    ...data,
    updatedAt: serverTimestamp(),
  });
}

export async function addNote(
  contactId: string,
  content: string,
  userId: string,
): Promise<string> {
  const ref = await addDoc(
    collection(getFirebaseDb(), CONTACTS, contactId, "notes"),
    {
      content,
      createdBy: userId,
      createdAt: serverTimestamp(),
    },
  );
  return ref.id;
}

export function subscribeToNotes(
  contactId: string,
  callback: (notes: Note[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  // Capped like activities; the timeline re-reads this on every profile open.
  const q = query(
    collection(getFirebaseDb(), CONTACTS, contactId, "notes"),
    orderBy("createdAt", "desc"),
    limit(50),
  );
  return onSnapshot(
    q,
    (snap) => {
      callback(
        snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Note, "id">) })),
      );
    },
    (err) => onError?.(err),
  );
}
