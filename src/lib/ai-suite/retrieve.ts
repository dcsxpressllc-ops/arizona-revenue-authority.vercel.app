import { AI_SUITE_KNOWLEDGE } from "@/lib/ai-suite/knowledge-base";
import type { AiSuiteKnowledgeCard, AiSuiteLevel } from "@/types/ai-suite";

/**
 * Keyword retriever over the knowledge base. No embeddings: the corpus is a few
 * dozen cards and queries are short, so keyword overlap is cheap and good
 * enough. Keeps context small since we only send the relevant cards.
 */

const STOPWORDS = new Set([
  "the", "a", "an", "how", "do", "i", "to", "in", "on", "of", "for", "is",
  "can", "with", "my", "me", "and", "or", "what", "where", "when", "does",
  "it", "this", "that", "you", "your", "am", "are", "be", "up", "set", "get",
  "use", "using", "add", "new",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function scoreCard(card: AiSuiteKnowledgeCard, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0;
  const title = card.title.toLowerCase();
  const keywordText = card.keywords.join(" ").toLowerCase();
  const bodyTokens = new Set(tokenize(card.body));
  let score = 0;
  for (const token of queryTokens) {
    // Keywords are the curated synonyms, so weight them highest.
    if (keywordText.includes(token)) score += 5;
    if (title.includes(token)) score += 4;
    if (bodyTokens.has(token)) score += 1;
  }
  return score;
}

/**
 * Best first. Falls back to a few default cards when nothing matches so the
 * model always has something grounded to work from.
 */
export function retrieveKnowledge(
  query: string,
  level: AiSuiteLevel,
  limit = 6,
): AiSuiteKnowledgeCard[] {
  const pool = AI_SUITE_KNOWLEDGE.filter((c) => c.levels.includes(level));
  const queryTokens = tokenize(query);

  const scored = pool
    .map((card) => ({ card, score: scoreCard(card, queryTokens) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.card);

  if (scored.length > 0) return scored;

  return pool.slice(0, Math.min(limit, 4));
}
