import type { Timestamp, FieldValue } from "firebase/firestore";

/**
 * Generic bulk import. Records carry the source system's external_id so re-runs
 * upsert; child records use contact_external_id to find their parent.
 * importMappings is the source-id <-> LeadStack-id index behind both.
 */

export type ImportSource = "csv" | "ghl" | "api";

export type ImportEntity = "contacts" | "deals" | "tasks" | "events" | "notes";

export const IMPORT_ENTITIES: ImportEntity[] = [
  "contacts",
  "deals",
  "tasks",
  "events",
  "notes",
];

export type ImportJobStatus = "queued" | "running" | "completed" | "failed";

export interface ImportEntityTotals {
  received: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
}

export function emptyTotals(): ImportEntityTotals {
  return { received: 0, created: 0, updated: 0, skipped: 0, failed: 0 };
}

/** A single failed record, surfaced in the job's capped error list. */
export interface ImportRecordError {
  entity: ImportEntity;
  externalId: string | null;
  error: string;
}

/** Max stored per-record errors per job. */
export const IMPORT_ERROR_CAP = 500;

export interface ImportJob {
  id: string;
  agencyId: string;
  subAccountId: string;
  createdByUid: string;
  source: ImportSource;
  status: ImportJobStatus;
  /** Entities not touched are absent. */
  totals: Partial<Record<ImportEntity, ImportEntityTotals>>;
  /** Capped at IMPORT_ERROR_CAP. */
  errors: ImportRecordError[];
  createdAt: Timestamp | FieldValue | null;
  updatedAt: Timestamp | FieldValue | null;
  finishedAt: Timestamp | FieldValue | null;
}

/**
 * Key is `${system}:${entity}:${safe(externalId)}`. Server-only.
 * parentId is set for notes (the owning contact) so upserts can find the subcollection doc.
 */
export interface ImportMappingDoc {
  entity: ImportEntity;
  system: ImportSource;
  externalId: string;
  leadstackId: string;
  parentId?: string | null;
  createdAt: Timestamp | FieldValue | null;
}
