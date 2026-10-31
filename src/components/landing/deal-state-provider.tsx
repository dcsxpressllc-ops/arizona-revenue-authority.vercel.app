// Hello world
import type { ReactNode } from "react";

export interface SeededDealState {
  cohort: unknown;
  nowMs: number;
}

export function DealStateProvider({
  children,
}: {
  value: SeededDealState | null;
  children: ReactNode;
}) {
  return children;
}

export function useSeededDealState(): SeededDealState | null {
  return null;
}
