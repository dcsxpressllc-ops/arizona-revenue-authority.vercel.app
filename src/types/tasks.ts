import type { Timestamp, FieldValue } from "firebase/firestore";

export interface Task {
  id: string;
  title: string;
  notes: string;
  dueAt: Timestamp | FieldValue | null;
  completed: boolean;
  completedAt: Timestamp | FieldValue | null;
  contactId: string | null;
  dealId: string | null;
  eventId: string | null;
  agencyId: string;
  subAccountId: string;
  createdByUid: string;
  /** Copied from the linked contact and kept in sync on retag. null = unscoped (admin-only when scoping is on). Ignored unless territoryScopingEnabled. */
  territoryId?: string | null;
  createdAt: Timestamp | FieldValue | null;
  updatedAt: Timestamp | FieldValue | null;
}

export type TaskFormData = {
  title: string;
  notes: string;
  dueAt: Date | null;
  contactId: string | null;
  dealId: string | null;
  eventId: string | null;
};

export type TaskFilter = "today" | "overdue" | "upcoming" | "done" | "all";
