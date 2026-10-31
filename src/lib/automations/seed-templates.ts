import "server-only";

import {
  FieldValue,
  type DocumentData,
  type DocumentReference,
  type Firestore,
} from "firebase-admin/firestore";
import { TEMPLATE_PRESETS } from "./template-presets";

// Takes a callback rather than WriteBatch | Transaction because TS can't unify
// their `.set()` overload return types.
export type SeedSetFn = (
  ref: DocumentReference<DocumentData>,
  data: DocumentData,
) => void;

/**
 * Seed the TEMPLATE_PRESETS into a new sub-account. Called from signup (batch)
 * and from /api/agency/sub-accounts (transaction). Runs inside the caller's
 * batch/transaction so the sub-account and its templates are created
 * atomically. Existing sub-accounts are deliberately not backfilled.
 */
export function seedDefaultTemplates(
  db: Firestore,
  setFn: SeedSetFn,
  scope: {
    agencyId: string;
    subAccountId: string;
    createdByUid: string;
  },
): void {
  for (const preset of TEMPLATE_PRESETS) {
    const ref = db.collection("message_templates").doc();
    setFn(ref, {
      id: ref.id,
      type: preset.type,
      name: preset.label,
      subject: preset.type === "email" ? preset.subject : null,
      body: preset.body,
      agencyId: scope.agencyId,
      subAccountId: scope.subAccountId,
      createdByUid: scope.createdByUid,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
}
