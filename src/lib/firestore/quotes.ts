import {
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  updateDoc,
  where,
  type QueryConstraint,
  type Unsubscribe,
} from "firebase/firestore";
import { getFirebaseDb } from "@/lib/firebase/client";
import {
  NOOP_UNSUB,
  territoryQueryPlan,
} from "@/lib/firestore/territory-query";
import type { Quote } from "@/types/quotes";
import type { TenantScope } from "@/types";

/**
 * Client-side CRUD and subscriptions for `quotes`. Reads go through the Web
 * SDK and per-sub-account rules, same TenantScope/onSnapshot pattern as
 * deals, events and tasks.
 *
 * Only the browser-side writes live here (draft auto-save, delete).
 * Lifecycle changes (send, paid, accept, decline) go through API routes that
 * also write the timeline row and fire triggers. Create is server-side too,
 * since the per-sub-account quote number has to be issued atomically
 * (lib/quotes/number.ts).
 */

const QUOTES = "quotes";

export interface QuoteQueryOptions {
  /** Territory filter for scoped collaborators; null = none. See deals.ts. */
  territoryFilter?: string[] | null;
}

export function subscribeToQuotes(
  scope: TenantScope,
  callback: (quotes: Quote[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe;
export function subscribeToQuotes(
  scope: TenantScope,
  opts: QuoteQueryOptions,
  callback: (quotes: Quote[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe;
export function subscribeToQuotes(
  scope: TenantScope,
  callbackOrOpts: ((quotes: Quote[]) => void) | QuoteQueryOptions,
  callbackOrError?: ((quotes: Quote[]) => void) | ((err: Error) => void),
  onErrorMaybe?: (err: Error) => void,
): Unsubscribe {
  const opts: QuoteQueryOptions =
    typeof callbackOrOpts === "function" ? {} : callbackOrOpts;
  const callback: (quotes: Quote[]) => void =
    typeof callbackOrOpts === "function"
      ? callbackOrOpts
      : (callbackOrError as (quotes: Quote[]) => void);
  const onError: ((err: Error) => void) | undefined =
    typeof callbackOrOpts === "function"
      ? (callbackOrError as ((err: Error) => void) | undefined)
      : onErrorMaybe;

  const plan = territoryQueryPlan(opts.territoryFilter);
  if (plan.mode === "empty") {
    callback([]);
    return NOOP_UNSUB;
  }
  const constraints: QueryConstraint[] = [
    where("subAccountId", "==", scope.subAccountId),
  ];
  if (plan.mode === "in") constraints.push(plan.constraint);
  const q = query(collection(getFirebaseDb(), QUOTES), ...constraints);
  return onSnapshot(
    q,
    (snap) => {
      const quotes = snap.docs.map(
        (d) => ({ id: d.id, ...(d.data() as Omit<Quote, "id">) }),
      );
      // Newest first; the list page can re-sort.
      quotes.sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));
      callback(quotes);
    },
    (err) => onError?.(err),
  );
}

export function subscribeToQuotesForContact(
  contactId: string,
  scope: TenantScope,
  callback: (quotes: Quote[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  const q = query(
    collection(getFirebaseDb(), QUOTES),
    where("subAccountId", "==", scope.subAccountId),
    where("contactId", "==", contactId),
  );
  return onSnapshot(
    q,
    (snap) => {
      const quotes = snap.docs.map(
        (d) => ({ id: d.id, ...(d.data() as Omit<Quote, "id">) }),
      );
      quotes.sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));
      callback(quotes);
    },
    (err) => onError?.(err),
  );
}

export function subscribeToQuote(
  id: string,
  callback: (quote: Quote | null) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  return onSnapshot(
    doc(getFirebaseDb(), QUOTES, id),
    (snap) => {
      if (!snap.exists()) {
        callback(null);
        return;
      }
      callback({ id: snap.id, ...(snap.data() as Omit<Quote, "id">) });
    },
    (err) => onError?.(err),
  );
}

/**
 * Despite the name, this doesn't gate on status: sent quotes are editable
 * too, as in GHL. A SIGNED quote is the exception: the rules refuse content
 * edits once `signature` is set, and the detail page hides Edit.
 */
export async function updateDraftQuote(
  id: string,
  patch: Partial<
    Pick<
      Quote,
      | "lineItems"
      | "globalDiscount"
      | "globalTaxPercent"
      | "termsAndNotes"
      | "billedToOrganization"
      | "billingAddress"
      | "validUntil"
      | "paymentDueDays"
      | "currency"
      | "autoCreateDealOnAccept"
      | "dealId"
      | "requireSignature"
    >
  >,
): Promise<void> {
  await updateDoc(doc(getFirebaseDb(), QUOTES, id), {
    ...patch,
    updatedAt: serverTimestamp(),
  });
}

/** Hard delete, meant for drafts. Sent quotes should be declined/paid so history survives; the UI and rules enforce that, not this helper. */
export async function deleteQuote(id: string): Promise<void> {
  await deleteDoc(doc(getFirebaseDb(), QUOTES, id));
}

function toMillis(v: unknown): number {
  if (!v) return 0;
  if (v instanceof Date) return v.getTime();
  const maybe = v as { toDate?: () => Date; seconds?: number };
  if (typeof maybe.toDate === "function") return maybe.toDate().getTime();
  if (typeof maybe.seconds === "number") return maybe.seconds * 1000;
  return 0;
}
