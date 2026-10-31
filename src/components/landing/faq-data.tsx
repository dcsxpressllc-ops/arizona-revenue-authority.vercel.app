// Hello world
import type { ReactNode } from "react";

export interface FaqItem {
  question: string;
  answer: ReactNode;
  plainAnswer: string;
}

export function buildFaqs(_dealName: string): FaqItem[] {
  return [];
}
