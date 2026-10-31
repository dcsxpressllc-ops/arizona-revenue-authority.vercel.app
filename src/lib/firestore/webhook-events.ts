import "server-only";

import { FieldValue, type Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import type {
  WebhookDeliveryDoc,
  WebhookDeliveryStatus,
  WebhookEventDoc,
  WebhookEventLogResponse,
  WebhookEventType,
} from "@/types/webhooks";

/**
 * Server-side CRUD for `subAccounts/{id}/webhookEvents/{eventId}` and
 * `deliveries/{deliveryId}`. Events are append-only with a 90-day TTL on
 * `expiresAt`. Deliveries move through pending -> succeeded / failed /
 * exhausted and are never deleted, so failures can be debugged later.
 * Rules allow admin reads for the viewer; writes are Admin SDK only.
 */

const EVENT_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function tsToDate(ts: Timestamp | Date | null | undefined): Date | null {
  if (!ts) return null;
  if (ts instanceof Date) return ts;
  if (typeof (ts as Timestamp).toDate === "function") {
    return (ts as Timestamp).toDate();
  }
  return null;
}

function eventSnapToDoc(
  id: string,
  data: FirebaseFirestore.DocumentData,
): WebhookEventDoc {
  return {
    id,
    subAccountId: data.subAccountId,
    agencyId: data.agencyId,
    mode: data.mode,
    type: data.type as WebhookEventType,
    payload: data.payload,
    subscriptionIds: (data.subscriptionIds ?? []) as string[],
    createdAt: tsToDate(data.createdAt) ?? new Date(0),
    expiresAt: tsToDate(data.expiresAt) ?? new Date(0),
  };
}

function deliverySnapToDoc(
  id: string,
  data: FirebaseFirestore.DocumentData,
): WebhookDeliveryDoc {
  return {
    id,
    eventId: data.eventId,
    subscriptionId: data.subscriptionId,
    subAccountId: data.subAccountId,
    agencyId: data.agencyId,
    attempt: data.attempt ?? 1,
    url: data.url,
    status: data.status as WebhookDeliveryStatus,
    httpStatus: data.httpStatus ?? null,
    responseBody: data.responseBody ?? null,
    responseHeaders: data.responseHeaders ?? null,
    errorMessage: data.errorMessage ?? null,
    scheduledAt: tsToDate(data.scheduledAt) ?? new Date(0),
    attemptedAt: tsToDate(data.attemptedAt),
    nextRetryAt: tsToDate(data.nextRetryAt),
  };
}

export interface CreateEventInput {
  subAccountId: string;
  agencyId: string;
  mode: "live" | "test";
  type: WebhookEventType;
  payload: unknown;
  subscriptionIds: string[];
}

export async function createEvent(
  input: CreateEventInput,
): Promise<WebhookEventDoc> {
  const ref = getAdminDb()
    .collection("subAccounts")
    .doc(input.subAccountId)
    .collection("webhookEvents")
    .doc();
  const now = new Date();
  const expiresAt = new Date(Date.now() + EVENT_TTL_MS);
  await ref.set({
    subAccountId: input.subAccountId,
    agencyId: input.agencyId,
    mode: input.mode,
    type: input.type,
    payload: input.payload,
    subscriptionIds: input.subscriptionIds,
    createdAt: FieldValue.serverTimestamp(),
    expiresAt,
  });
  return {
    id: ref.id,
    subAccountId: input.subAccountId,
    agencyId: input.agencyId,
    mode: input.mode,
    type: input.type,
    payload: input.payload,
    subscriptionIds: input.subscriptionIds,
    createdAt: now,
    expiresAt,
  };
}

export async function getEvent(
  subAccountId: string,
  eventId: string,
): Promise<WebhookEventDoc | null> {
  const snap = await getAdminDb()
    .collection("subAccounts")
    .doc(subAccountId)
    .collection("webhookEvents")
    .doc(eventId)
    .get();
  if (!snap.exists) return null;
  return eventSnapToDoc(snap.id, snap.data()!);
}

export interface CreateDeliveryInput {
  subAccountId: string;
  agencyId: string;
  eventId: string;
  subscriptionId: string;
  attempt: number;
  url: string;
  scheduledAt: Date;
}

export async function createDelivery(
  input: CreateDeliveryInput,
): Promise<WebhookDeliveryDoc> {
  const ref = getAdminDb()
    .collection("subAccounts")
    .doc(input.subAccountId)
    .collection("webhookEvents")
    .doc(input.eventId)
    .collection("deliveries")
    .doc();
  await ref.set({
    eventId: input.eventId,
    subscriptionId: input.subscriptionId,
    subAccountId: input.subAccountId,
    agencyId: input.agencyId,
    attempt: input.attempt,
    url: input.url,
    status: "pending" satisfies WebhookDeliveryStatus,
    httpStatus: null,
    responseBody: null,
    responseHeaders: null,
    errorMessage: null,
    scheduledAt: input.scheduledAt,
    attemptedAt: null,
    nextRetryAt: null,
  });
  return {
    id: ref.id,
    eventId: input.eventId,
    subscriptionId: input.subscriptionId,
    subAccountId: input.subAccountId,
    agencyId: input.agencyId,
    attempt: input.attempt,
    url: input.url,
    status: "pending",
    httpStatus: null,
    responseBody: null,
    responseHeaders: null,
    errorMessage: null,
    scheduledAt: input.scheduledAt,
    attemptedAt: null,
    nextRetryAt: null,
  };
}

export async function getDelivery(
  subAccountId: string,
  eventId: string,
  deliveryId: string,
): Promise<WebhookDeliveryDoc | null> {
  const snap = await getAdminDb()
    .collection("subAccounts")
    .doc(subAccountId)
    .collection("webhookEvents")
    .doc(eventId)
    .collection("deliveries")
    .doc(deliveryId)
    .get();
  if (!snap.exists) return null;
  return deliverySnapToDoc(snap.id, snap.data()!);
}

function tsToIso(ts: Timestamp | Date | null | undefined): string | null {
  const d = tsToDate(ts);
  return d ? d.toISOString() : null;
}

/**
 * Recent events with deliveries nested, newest first, for Logs -> Webhooks.
 * Deliveries are sorted in memory, so only the auto single-field index is
 * needed. `limit` clamps to [1, 50]; deliveries per event are bounded by the
 * subscription count.
 */
export async function listRecentEventsWithDeliveries(
  subAccountId: string,
  opts: { limit?: number } = {},
): Promise<WebhookEventLogResponse[]> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 50);
  const eventsSnap = await getAdminDb()
    .collection("subAccounts")
    .doc(subAccountId)
    .collection("webhookEvents")
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();

  return Promise.all(
    eventsSnap.docs.map(async (eventDoc) => {
      const ev = eventDoc.data();
      const delSnap = await eventDoc.ref.collection("deliveries").get();
      const deliveries = delSnap.docs
        .map((d) => {
          const data = d.data();
          return {
            id: d.id,
            subscriptionId: (data.subscriptionId as string) ?? "",
            url: (data.url as string) ?? "",
            attempt: (data.attempt as number) ?? 1,
            status: (data.status as WebhookDeliveryStatus) ?? "pending",
            httpStatus: (data.httpStatus as number | null) ?? null,
            errorMessage: (data.errorMessage as string | null) ?? null,
            responseBody: (data.responseBody as string | null) ?? null,
            scheduledAt: tsToIso(data.scheduledAt) ?? new Date(0).toISOString(),
            attemptedAt: tsToIso(data.attemptedAt),
            nextRetryAt: tsToIso(data.nextRetryAt),
          };
        })
        .sort((a, b) => a.attempt - b.attempt);
      return {
        id: eventDoc.id,
        type: ev.type as WebhookEventType,
        mode: (ev.mode as "live" | "test") ?? "live",
        createdAt: tsToIso(ev.createdAt) ?? new Date(0).toISOString(),
        subscriptionCount: ((ev.subscriptionIds ?? []) as string[]).length,
        deliveries,
      };
    }),
  );
}

export async function updateDelivery(
  subAccountId: string,
  eventId: string,
  deliveryId: string,
  patch: Partial<{
    status: WebhookDeliveryStatus;
    httpStatus: number | null;
    responseBody: string | null;
    responseHeaders: string | null;
    errorMessage: string | null;
    attemptedAt: Date | null;
    nextRetryAt: Date | null;
  }>,
): Promise<void> {
  await getAdminDb()
    .collection("subAccounts")
    .doc(subAccountId)
    .collection("webhookEvents")
    .doc(eventId)
    .collection("deliveries")
    .doc(deliveryId)
    .set(patch, { merge: true });
}
