import type { WorkflowNode, WorkflowNodeType } from "@/types/workflows";

/**
 * The builder edits a tree (a branching step holds two nested lists); the
 * engine stores a node map with next/branch pointers. A branching step is
 * always last in its list.
 */
export interface BuilderStep {
  id: string;
  type: WorkflowNodeType;
  config: Record<string, unknown>;
  whenTrue?: BuilderStep[];
  whenFalse?: BuilderStep[];
}

export function isBranchingType(t: WorkflowNodeType): boolean {
  return t === "if_else" || t === "wait_for_reply";
}

export function newNodeId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `n_${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export function parseTree(
  nodes: Record<string, WorkflowNode>,
  startNodeId: string | null,
): BuilderStep[] {
  const walk = (start: string | null): BuilderStep[] => {
    const out: BuilderStep[] = [];
    const seen = new Set<string>();
    let cur = start;
    while (cur && nodes[cur] && !seen.has(cur)) {
      seen.add(cur);
      const n = nodes[cur];
      const step: BuilderStep = {
        id: n.id,
        type: n.type,
        config: n.config ?? {},
      };
      if (isBranchingType(n.type)) {
        step.whenTrue = walk(n.branches?.whenTrue ?? null);
        step.whenFalse = walk(n.branches?.whenFalse ?? null);
        out.push(step);
        break; // a branching step is terminal in a list
      }
      out.push(step);
      cur = n.next ?? null;
    }
    return out;
  };
  return walk(startNodeId);
}

/** Returns the node map and entry id. */
export function flattenTree(steps: BuilderStep[]): {
  nodes: Record<string, WorkflowNode>;
  startNodeId: string | null;
} {
  const nodes: Record<string, WorkflowNode> = {};
  const build = (list: BuilderStep[]): string | null => {
    let firstId: string | null = null;
    let prev: WorkflowNode | null = null;
    for (const s of list) {
      const node: WorkflowNode = { id: s.id, type: s.type, config: s.config };
      if (isBranchingType(s.type)) {
        node.branches = {
          whenTrue: build(s.whenTrue ?? []),
          whenFalse: build(s.whenFalse ?? []),
        };
      }
      nodes[s.id] = node;
      if (!firstId) firstId = s.id;
      if (prev && !isBranchingType(prev.type)) prev.next = s.id;
      prev = node;
    }
    return firstId;
  };
  const startNodeId = build(steps);
  return { nodes, startNodeId };
}
