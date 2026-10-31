import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { emitWebhookEvent } from "@/lib/api/webhooks/dispatch";
import { fireWorkflowTrigger } from "@/lib/workflows/engine";
import { runAfterResponse } from "@/lib/server/after-response";
import {
  serializeContactForApi,
  type ContactApiObject,
} from "@/lib/api/serializers/contacts";
import type { ContactAttribution } from "@/types/contacts";
import type { CustomFieldValue } from "@/types/custom-fields";
import { normalizePhoneLenient } from "@/lib/contacts/phone";
import { GLOBAL_TERRITORY_ID } from "@/types";

/**
 * Server-side contact writes: the one place a contact is created/updated and
 * its webhook fires. Dashboard routes and `POST /api/v1/contacts` both go
 * through here, so UI-created contacts fire the same events as API ones.
 * Cheap when nobody's subscribed: emitWebhookEvent returns after one lookup.
 */

type Mode = "live" | "test";

/**
 * Superset of the dashboard `ContactFormData` and API `ContactCreateInput`.
 * Everything after `tags` is optional.
 */
export interface CreateContactInput {
  subAccountId: string;
  agencyId: string;
  createdByUid: string;
  mode: Mode;
  name: string;
  email: string;
  phone: string;
  /** Workspace `defaultPhoneCountry` for E.164 normalization (lib/contacts/phone.ts); defaults to "US". */
  phoneCountry?: string | null;
  company: string;
  address: string;
  source: string;
  tags: string[];
  pipelineStage?: string | null;
  territoryId?: string | null;
  /** Already validated against live defs by the route. */
  customFields?: Record<string, CustomFieldValue> | null;
  attribution?: ContactAttribution | null;
  /** Supplied by form submits, not the UI. */
  location?: {
    countryCode: string | null;
    country: string | null;
    city: string | null;
    lat: number | null;
    lng: number | null;
  } | null;
}

export interface ContactWriteResult {
  id: string;
  contact: ContactApiObject;
}

/**
 * True when `contactId` belongs to another sub-account. Deal/task/event routes
 * check this before linking so A can't pull B's contact through its own
 * webhooks/workflows/timeline. A missing contact returns false; only a
 * confirmed cross-tenant id is refused (same check as `POST /api/v1/deals`).
 */
export async function contactBelongsToOtherSubAccount(
  contactId: string,
  subAccountId: string,
): Promise<boolean> {
  const snap = await getAdminDb().doc(`contacts/${contactId}`).get();
  if (!snap.exists) return false;
  return snap.data()?.subAccountId !== subAccountId;
}

/** Create a contact and emit `contact.created` (fire-and-forget). Returns id + wire object. */
export async function createContactServerSide(
  input: CreateContactInput,
): Promise<ContactWriteResult> {
  const db = getAdminDb();
  const ref = db.collection("contacts").doc();
  const loc = input.location ?? null;

  const doc = {
    name: input.name,
    email: input.email,
    phone: normalizePhoneLenient(input.phone, input.phoneCountry),
    company: input.company,
    address: input.address,
    source: input.source,
    tags: input.tags,
    pipelineStage: input.pipelineStage ?? null,
    customFields: input.customFields ?? {},
    attribution: input.attribution ?? null,
    emailOptedOut: false,
    smsOptedOut: false,
    countryCode: loc?.countryCode ?? null,
    country: loc?.country ?? null,
    city: loc?.city ?? null,
    lat: loc?.lat ?? null,
    lng: loc?.lng ?? null,
    territoryId: input.territoryId ?? GLOBAL_TERRITORY_ID,
    agencyId: input.agencyId,
    subAccountId: input.subAccountId,
    createdByUid: input.createdByUid,
    mode: input.mode,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  await ref.set(doc);

  // Serialize with a JS `now` instead of re-reading for the serverTimestamp values;
  // sub-ms drift on created_at doesn't matter to subscribers.
  const now = new Date();
  const contact = serializeContactForApi(
    ref.id,
    { ...doc, createdAt: now, updatedAt: now },
    input.mode,
  );

  void emitWebhookEvent({
    subAccountId: input.subAccountId,
    agencyId: input.agencyId,
    mode: input.mode,
    type: "contact.created",
    payload: { contact },
  });
  if (input.mode === "live") {
    void fireWorkflowTrigger({
      subAccountId: input.subAccountId,
      agencyId: input.agencyId,
      type: "contact.created",
      contactId: ref.id,
    });
  }

  return { id: ref.id, contact };
}

/** Only provided keys are written. */
export interface UpdateContactPatch {
  name?: string;
  email?: string;
  phone?: string;
  company?: string;
  address?: string;
  source?: string;
  tags?: string[];
  pipelineStage?: string | null;
  /** Replaces the whole map (validated by the route). */
  customFields?: Record<string, CustomFieldValue>;
}

/**
 * Update a contact and emit `contact.updated` with the merged doc. Returns null
 * if it doesn't exist. `territoryId` isn't handled here: moving territory fans
 * out to deals/quotes/tasks/events via a dedicated admin endpoint.
 */
export async function updateContactServerSide(opts: {
  contactId: string;
  patch: UpdateContactPatch;
  /** From the existing doc; defaults to live. */
  mode?: Mode;
}): Promise<ContactWriteResult | null> {
  const db = getAdminDb();
  const ref = db.doc(`contacts/${opts.contactId}`);
  const snap = await ref.get();
  if (!snap.exists) return null;

  const existing = snap.data()!;
  const mode = opts.mode ?? (existing.mode as Mode) ?? "live";

  // update(), not set(merge): merge recurses into maps and would keep cleared
  // customFields values forever. update() replaces map fields wholesale.
  await ref.update({ ...opts.patch, updatedAt: FieldValue.serverTimestamp() });

  const fresh = await ref.get();
  const contact = serializeContactForApi(fresh.id, fresh.data()!, mode);

  void emitWebhookEvent({
    subAccountId: existing.subAccountId,
    agencyId: existing.agencyId,
    mode,
    type: "contact.updated",
    payload: { contact },
  });
  // Tags patch replaces the list, so diff against the pre-update tags.
  if (mode === "live" && opts.patch.tags) {
    const oldTags: string[] = Array.isArray(existing.tags) ? existing.tags : [];
    const added = opts.patch.tags.filter((t) => !oldTags.includes(t));
    if (added.length > 0) {
      void fireWorkflowTrigger({
        subAccountId: existing.subAccountId,
        agencyId: existing.agencyId,
        type: "contact.tag.added",
        contactId: opts.contactId,
        context: { addedTags: added },
      });
    }
  }

  return { id: ref.id, contact };
}

/**
 * Emit `contact.created` for a contact written elsewhere (form submit, chat /
 * voice capture, booking reconcile). Self-guarded, safe to `void`.
 *
 * runAfterResponse() is registered at call time, before the Firestore read.
 * Registering after() only inside emitWebhookEvent is too late: the route
 * often returns, and Vercel freezes the function, mid-read.
 */
export async function emitContactCreatedById(opts: {
  subAccountId: string;
  agencyId: string;
  contactId: string;
  mode?: Mode;
}): Promise<void> {
  runAfterResponse(() => runEmitContactCreatedById(opts));
}

async function runEmitContactCreatedById(opts: {
  subAccountId: string;
  agencyId: string;
  contactId: string;
  mode?: Mode;
}): Promise<void> {
  try {
    const snap = await getAdminDb().doc(`contacts/${opts.contactId}`).get();
    if (!snap.exists) return;
    const mode = opts.mode ?? (snap.data()!.mode as Mode) ?? "live";
    const contact = serializeContactForApi(snap.id, snap.data()!, mode);
    await emitWebhookEvent({
      subAccountId: opts.subAccountId,
      agencyId: opts.agencyId,
      mode,
      type: "contact.created",
      payload: { contact },
    });
    if (mode === "live") {
      void fireWorkflowTrigger({
        subAccountId: opts.subAccountId,
        agencyId: opts.agencyId,
        type: "contact.created",
        contactId: opts.contactId,
      });
    }
  } catch (err) {
    console.warn("[contacts-service] emitContactCreatedById failed", err);
  }
}

/** Emit `contact.deleted` from the pre-delete snapshot the DELETE route already read. */
export function emitContactDeleted(opts: {
  subAccountId: string;
  agencyId: string;
  contactId: string;
  data: FirebaseFirestore.DocumentData;
  mode?: Mode;
}): void {
  const mode = opts.mode ?? (opts.data.mode as Mode) ?? "live";
  const contact = serializeContactForApi(opts.contactId, opts.data, mode);
  void emitWebhookEvent({
    subAccountId: opts.subAccountId,
    agencyId: opts.agencyId,
    mode,
    type: "contact.deleted",
    payload: { contact },
  });
}
