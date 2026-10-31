/**
 * In-app assistant. Two levels: agency (`/agency/ai-suite`, running the
 * agency) and sub-account (`/sa/[id]/ai-suite`, the working CRM). It answers
 * from curated knowledge cards and only writes through confirm-gated
 * capabilities.
 */

export type AiSuiteLevel = "agency" | "sub-account";

/** System messages are built server-side, never accepted from the client. */
export interface AiSuiteChatMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Curated fact the retriever can hand the model. Only top matches go into
 * context, and the model is told not to state setup details that aren't in
 * a retrieved card's `body`.
 */
export interface AiSuiteKnowledgeCard {
  /** Stable kebab-case id. */
  id: string;
  levels: AiSuiteLevel[];
  /** e.g. "Pipeline (Kanban)". */
  title: string;
  /** e.g. "Sidebar -> Pipeline". */
  location: string;
  /** Synonyms the user might type. */
  keywords: string[];
  body: string;
}

export interface AiSuiteChatRequest {
  level: AiSuiteLevel;
  /** Required for the sub-account level; auth is scoped to it. */
  subAccountId?: string;
  /** Whole conversation; the API is stateless. */
  messages: AiSuiteChatMessage[];
}

/**
 * Nothing has run yet. On confirm, the endpoint re-checks permission and
 * re-validates before executing.
 */
export interface AiSuiteProposedAction {
  /** The model's tool-call id. */
  id: string;
  /** Registry capability name. */
  capability: string;
  args: Record<string, unknown>;
  /** One-liner for the confirm card. */
  summary: string;
}

/** `navigate` hrefs are built server-side from the caller's own memberships. */
export type AiSuiteChatResponse =
  | { type: "message"; text: string }
  | { type: "proposal"; proposal: AiSuiteProposedAction }
  | { type: "navigate"; text: string; href: string; label: string };

export interface AiSuiteConfirmRequest {
  level: AiSuiteLevel;
  subAccountId?: string;
  capability: string;
  args: Record<string, unknown>;
}

export interface AiSuiteConfirmResponse {
  ok: true;
  resultText: string;
}
