import "server-only";

import type { Firestore } from "firebase-admin/firestore";
import type {
  SnapshotForm,
  SnapshotMessageTemplate,
  SnapshotPayload,
  SnapshotProduct,
  SnapshotWorkflow,
} from "@/types/snapshots";

/** Per-tenant fields, stripped on capture; apply re-stamps them on the target. */
const TENANCY_STAMPS = [
  "id",
  "agencyId",
  "subAccountId",
  "createdByUid",
  "createdAt",
  "updatedAt",
] as const;

/** Strip tenancy/identity/audit/runtime fields, keeping the doc id as `sourceId`
 *  so apply can remap form ids in workflow triggers. */
function stripDoc(
  id: string,
  data: FirebaseFirestore.DocumentData,
  extraOmit: readonly string[] = [],
): Record<string, unknown> {
  const omit = new Set<string>([...TENANCY_STAMPS, ...extraOmit]);
  const out: Record<string, unknown> = { sourceId: id };
  for (const [key, value] of Object.entries(data)) {
    if (!omit.has(key)) out[key] = value;
  }
  return out;
}

/**
 * Capture reusable config (forms, message templates, products, workflows) into a
 * portable payload. Read-only, and customer data (submissions, runs, contacts,
 * deals) is never read. Workflow `stats` and form `submissionCount` are dropped.
 */
export async function captureSnapshot(
  db: Firestore,
  sourceSubAccountId: string,
): Promise<SnapshotPayload> {
  const [formsSnap, templatesSnap, productsSnap, workflowsSnap] =
    await Promise.all([
      db.collection("forms").where("subAccountId", "==", sourceSubAccountId).get(),
      db
        .collection("message_templates")
        .where("subAccountId", "==", sourceSubAccountId)
        .get(),
      db
        .collection("products")
        .where("subAccountId", "==", sourceSubAccountId)
        .get(),
      db
        .collection("workflows")
        .where("subAccountId", "==", sourceSubAccountId)
        .get(),
    ]);

  const forms = formsSnap.docs.map(
    (d) => stripDoc(d.id, d.data(), ["submissionCount"]) as unknown as SnapshotForm,
  );
  const messageTemplates = templatesSnap.docs.map(
    (d) => stripDoc(d.id, d.data()) as unknown as SnapshotMessageTemplate,
  );
  // Sell-online fields point at the source workspace (its Storage files,
  // groups, checkout pages), so they stay behind; the copy is catalog-only.
  const products = productsSnap.docs.map(
    (d) =>
      stripDoc(d.id, d.data(), [
        "images",
        "imageGeneration",
        "imageGenerationDay",
        "sellOnline",
        "slug",
        "checkoutPageId",
        "delivery",
        "publicVersion",
      ]) as unknown as SnapshotProduct,
  );
  const workflows = workflowsSnap.docs.map(
    (d) => stripDoc(d.id, d.data(), ["stats"]) as unknown as SnapshotWorkflow,
  );

  return { forms, messageTemplates, products, workflows };
}
