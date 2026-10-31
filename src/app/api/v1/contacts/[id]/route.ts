import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { withApiAuth } from "@/lib/api/auth";
import { apiError, apiOk } from "@/lib/api/responses";
import { emitWebhookEvent } from "@/lib/api/webhooks/dispatch";
import {
  parseContactPatch,
  serializeContactForApi,
  type ContactCreateInput,
} from "@/lib/api/serializers/contacts";
import { loadCustomFieldDefs } from "@/lib/custom-fields/load-defs";
import { validateCustomFieldValues } from "@/lib/custom-fields/validation";

/**
 * Public API v1, single contact: GET, PATCH (partial), DELETE (same cleanup
 * as the dashboard delete: its deals are deleted, tasks/events unlinked).
 *
 * Every call re-reads the doc and checks subAccountId and mode against the
 * key. Anything outside scope is a 404, never a 403. contact.updated and
 * contact.deleted fire after the write; webhook failures don't roll it back.
 */

export const GET = withApiAuth<{ id: string }>(async ({ params, ctx }) => {
  const snap = await getAdminDb().doc(`contacts/${params.id}`).get();
  if (!snap.exists) {
    return apiError(ctx, "not_found", "contact_not_found", "Contact not found.");
  }
  const data = snap.data()!;
  if (data.subAccountId !== ctx.subAccountId || data.mode !== ctx.mode) {
    return apiError(ctx, "not_found", "contact_not_found", "Contact not found.");
  }
  return apiOk(ctx, {
    contact: serializeContactForApi(snap.id, data, ctx.mode),
  });
});

export const PATCH = withApiAuth<{ id: string }>(async ({ body, params, ctx }) => {
  const parsed = parseContactPatch(body);
  if (!parsed.ok) {
    return apiError(ctx, "invalid_request", "invalid_body", parsed.error!);
  }
  const patch = parsed.value!;

  const ref = getAdminDb().doc(`contacts/${params.id}`);
  const snap = await ref.get();
  if (!snap.exists) {
    return apiError(ctx, "not_found", "contact_not_found", "Contact not found.");
  }
  const existing = snap.data()!;
  if (existing.subAccountId !== ctx.subAccountId || existing.mode !== ctx.mode) {
    return apiError(ctx, "not_found", "contact_not_found", "Contact not found.");
  }

  const writePatch: Partial<ContactCreateInput> & {
    updatedAt: FirebaseFirestore.FieldValue;
  } = {
    ...patch,
    updatedAt: FieldValue.serverTimestamp(),
  };

  // custom_fields replaces the whole value map when present.
  if ((body as Record<string, unknown>).custom_fields !== undefined) {
    const cfDefs = await loadCustomFieldDefs(ctx.subAccountId, "contact");
    const cf = validateCustomFieldValues(
      (body as Record<string, unknown>).custom_fields,
      cfDefs,
    );
    if (!cf.ok) {
      return apiError(ctx, "invalid_request", "invalid_body", cf.error!);
    }
    writePatch.customFields = cf.value;
  }

  // update(), not set(merge): merge recurses into maps, so a cleared custom
  // field would survive the replacement.
  await ref.update(writePatch);

  const fresh = await ref.get();
  const wire = serializeContactForApi(fresh.id, fresh.data()!, ctx.mode);

  void emitWebhookEvent({
    subAccountId: ctx.subAccountId,
    agencyId: ctx.agencyId,
    mode: ctx.mode,
    type: "contact.updated",
    payload: { contact: wire },
  });

  return apiOk(ctx, { contact: wire });
});

export const DELETE = withApiAuth<{ id: string }>(async ({ params, ctx }) => {
  const db = getAdminDb();
  const ref = db.doc(`contacts/${params.id}`);
  const snap = await ref.get();
  if (!snap.exists) {
    return apiError(ctx, "not_found", "contact_not_found", "Contact not found.");
  }
  const existing = snap.data()!;
  if (existing.subAccountId !== ctx.subAccountId || existing.mode !== ctx.mode) {
    return apiError(ctx, "not_found", "contact_not_found", "Contact not found.");
  }

  // Same cleanup as the dashboard delete (api/contacts/[id]): recursive
  // delete of the contact, delete its deals, null contactId on tasks/events.
  await db.recursiveDelete(ref);

  // Same mode only, so a live delete never touches test deals.
  const dealsSnap = await db
    .collection("deals")
    .where("subAccountId", "==", ctx.subAccountId)
    .where("mode", "==", ctx.mode)
    .where("contactId", "==", params.id)
    .get();
  if (!dealsSnap.empty) {
    const batch = db.batch();
    for (const d of dealsSnap.docs) batch.delete(d.ref);
    await batch.commit();
  }

  for (const collection of ["tasks", "events"] as const) {
    const s = await db
      .collection(collection)
      .where("subAccountId", "==", ctx.subAccountId)
      .where("mode", "==", ctx.mode)
      .where("contactId", "==", params.id)
      .get();
    if (s.empty) continue;
    const batch = db.batch();
    for (const d of s.docs) batch.update(d.ref, { contactId: null });
    await batch.commit();
  }

  void emitWebhookEvent({
    subAccountId: ctx.subAccountId,
    agencyId: ctx.agencyId,
    mode: ctx.mode,
    type: "contact.deleted",
    payload: {
      contact: { id: params.id, object: "contact", deleted: true },
    },
  });

  return apiOk(ctx, { id: params.id, object: "contact", deleted: true });
});
