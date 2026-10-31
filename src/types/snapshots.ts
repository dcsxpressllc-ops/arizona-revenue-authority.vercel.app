import type { Timestamp, FieldValue } from "firebase/firestore";
import type { LeadForm } from "./forms";
import type { Product } from "./products";
import type { MessageTemplateDoc } from "./automations";
import type { WorkflowDoc } from "./workflows";

/**
 * A copy of one sub-account's config (forms, templates, products, workflows)
 * that can be applied to another. Never holds customer data or credentials.
 * Stored at agencies/{agencyId}/snapshots, owner-read, server-write.
 * `version` lets apply migrate old snapshots after a schema change.
 */

export const SNAPSHOT_VERSION = 1 as const;

/** Stripped on capture, re-stamped on apply. */
type TenancyStamps =
  | "id"
  | "agencyId"
  | "subAccountId"
  | "createdByUid"
  | "createdAt"
  | "updatedAt";

/** sourceId lets apply map old form ids to new ones for workflow trigger.formId. */
type Captured<T> = { sourceId: string } & T;

export type SnapshotForm = Captured<
  Omit<LeadForm, TenancyStamps | "submissionCount">
>;

export type SnapshotMessageTemplate = Captured<
  Omit<MessageTemplateDoc, TenancyStamps>
>;

export type SnapshotProduct = Captured<Omit<Product, TenancyStamps>>;

/**
 * The node graph copies as-is. trigger.formId still holds the source form id;
 * apply remaps it, or nulls it if that form wasn't captured.
 */
export type SnapshotWorkflow = Captured<
  Omit<WorkflowDoc, TenancyStamps | "stats">
>;

export interface SnapshotPayload {
  forms: SnapshotForm[];
  messageTemplates: SnapshotMessageTemplate[];
  products: SnapshotProduct[];
  workflows: SnapshotWorkflow[];
}

export interface SnapshotDoc {
  id: string;
  agencyId: string;
  name: string;
  description: string;
  version: typeof SNAPSHOT_VERSION;
  /** Provenance only. */
  sourceSubAccountId: string;
  createdByUid: string;
  createdAt: Timestamp | FieldValue | null;
  payload: SnapshotPayload;
}

export interface SnapshotApplyResult {
  formsCreated: number;
  templatesCreated: number;
  productsCreated: number;
  workflowsCreated: number;
  /** Workflows whose trigger.formId was remapped rather than nulled. */
  workflowsLinked: number;
}
