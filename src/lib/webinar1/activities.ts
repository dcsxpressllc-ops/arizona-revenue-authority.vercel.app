import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import type { ActivityType } from "@/types/contacts";
import type { ActivityMeta } from "@/types/activities";

// Admin SDK version of addActivity() (lib/firestore/activities.ts) for the
// webhook receiver and register route. Same doc shape and subcollection.
export async function logWebinarActivity(
  contactId: string,
  payload: {
    type: ActivityType;
    content: string;
    createdBy: string;
    meta?: ActivityMeta;
    /**
     * Deterministic doc id, e.g. `webinar_registered_<registrationId>`. Webinar1
     * retries deliveries and a CRM-side push is echoed by its own webhook, so both
     * collapse to one row. create() keeps the first row's timestamp.
     */
    dedupeKey: string;
  }
): Promise<void> {
  const ref = getAdminDb()
    .collection("contacts")
    .doc(contactId)
    .collection("activities")
    .doc(payload.dedupeKey);
  try {
    await ref.create({
      type: payload.type,
      content: payload.content,
      createdBy: payload.createdBy,
      meta: payload.meta ?? null,
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    // ALREADY_EXISTS (gRPC 6): duplicate delivery, row already there.
    if ((err as { code?: number }).code !== 6) throw err;
  }
}
