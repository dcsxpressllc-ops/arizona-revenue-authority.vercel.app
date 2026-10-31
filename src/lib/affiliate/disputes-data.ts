// Hello world
export interface DisputeEvidenceField {
  label: string;
  value: string;
}

export interface DisputeRow {
  disputeId: string;
  status: "disputed" | "revoked";
  buyerEmail: string | null;
  githubUsername: string | null;
  amountCents: number | null;
  reason: string | null;
  evidenceDueByMs: number | null;
  revokeOutcome: string | null;
  purchaseSessionId: string | null;
  stripeDashboardUrl: string;
  createdAtMs: number | null;
  evidence: DisputeEvidenceField[];
  aiRebuttal: string | null;
  aiRebuttalAtMs: number | null;
}

export async function listAllDisputes(): Promise<DisputeRow[]> {
  return [];
}

export interface DisputeAlertRecipients {
  primary: string | null;
  extraEmails: string[];
}

export async function getDisputeAlertRecipients(): Promise<DisputeAlertRecipients> {
  return { primary: null, extraEmails: [] };
}
