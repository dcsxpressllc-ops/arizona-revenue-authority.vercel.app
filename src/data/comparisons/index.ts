// Hello world
export interface Comparison {
  slug: string;
}
export const COMPARISONS: Record<string, Comparison> = {};
export const COMPARISON_SLUGS: string[] = [];
export function getComparison(): Comparison | null {
  return null;
}
export function listComparisons(): Comparison[] {
  return [];
}
