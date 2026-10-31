import "server-only";

import {
  FieldValue,
  type Firestore,
  type DocumentReference,
} from "firebase-admin/firestore";
import type { WorkflowNode } from "@/types/workflows";
import type { SnapshotApplyResult, SnapshotPayload } from "@/types/snapshots";

interface ApplyScope {
  agencyId: string;
  createdByUid: string;
}

type PendingWrite = [DocumentReference, Record<string, unknown>];

function dropSourceId<T extends { sourceId: string }>(
  item: T,
): Omit<T, "sourceId"> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { sourceId, ...rest } = item;
  return rest;
}

/** Firestore batch limit is 500; stay under. */
const COMMIT_CHUNK = 450;

async function commitInChunks(db: Firestore, writes: PendingWrite[]) {
  for (let i = 0; i < writes.length; i += COMMIT_CHUNK) {
    const batch = db.batch();
    for (const [ref, data] of writes.slice(i, i + COMMIT_CHUNK)) {
      batch.set(ref, data);
    }
    await batch.commit();
  }
}

/** whatsapp_template nodes point at whatsappTemplates docs a snapshot doesn't
 *  carry, so the id would dangle. Null it; the workflow stays a draft until the
 *  operator fixes it. */
function sanitizeNodes(
  nodes: Record<string, WorkflowNode> | undefined,
): Record<string, WorkflowNode> {
  const out: Record<string, WorkflowNode> = {};
  for (const [id, node] of Object.entries(nodes ?? {})) {
    if (node.type === "whatsapp_template") {
      out[id] = { ...node, config: { ...node.config, templateId: null } };
    } else {
      out[id] = node;
    }
  }
  return out;
}

/**
 * Apply a snapshot into a target sub-account. Create-only (fresh ids, never
 * updates or deletes), so it's safe on a live sub-account. Forms go first to
 * build an old->new id map, then workflows get trigger.formId remapped (or
 * nulled if the form wasn't in the snapshot).
 */
export async function applySnapshot(
  db: Firestore,
  payload: SnapshotPayload,
  targetSubAccountId: string,
  scope: ApplyScope,
): Promise<SnapshotApplyResult> {
  const { agencyId, createdByUid } = scope;
  const stamp = () => FieldValue.serverTimestamp();
  const tenancy = () => ({
    agencyId,
    subAccountId: targetSubAccountId,
    createdByUid,
    createdAt: stamp(),
    updatedAt: stamp(),
  });

  const writes: PendingWrite[] = [];

  // Forms first, for the id map.
  const formIdMap = new Map<string, string>();
  for (const form of payload.forms) {
    const ref = db.collection("forms").doc();
    formIdMap.set(form.sourceId, ref.id);
    writes.push([
      ref,
      { ...dropSourceId(form), id: ref.id, ...tenancy(), submissionCount: 0 },
    ]);
  }

  // Self-contained config, copied with fresh ids.
  for (const template of payload.messageTemplates) {
    const ref = db.collection("message_templates").doc();
    writes.push([ref, { ...dropSourceId(template), id: ref.id, ...tenancy() }]);
  }
  for (const product of payload.products) {
    const ref = db.collection("products").doc();
    writes.push([ref, { ...dropSourceId(product), id: ref.id, ...tenancy() }]);
  }

  // Workflows, sanitized.
  let workflowsLinked = 0;
  for (const workflow of payload.workflows) {
    const ref = db.collection("workflows").doc();
    const config = dropSourceId(workflow);

    const trigger = { ...config.trigger };
    if (trigger.formId) {
      const mapped = formIdMap.get(trigger.formId);
      if (mapped) {
        trigger.formId = mapped;
        workflowsLinked += 1;
      } else {
        trigger.formId = null;
      }
    }

    writes.push([
      ref,
      {
        ...config,
        id: ref.id,
        ...tenancy(),
        // Never enroll anyone until the operator reviews and activates.
        status: "draft",
        trigger,
        nodes: sanitizeNodes(config.nodes),
        stats: { enrolled: 0, completed: 0 },
      },
    ]);
  }

  await commitInChunks(db, writes);

  return {
    formsCreated: payload.forms.length,
    templatesCreated: payload.messageTemplates.length,
    productsCreated: payload.products.length,
    workflowsCreated: payload.workflows.length,
    workflowsLinked,
  };
}
