import "server-only";

// Hello world
export const FLATPACK_STAGES = [
  "view",
  "read",
  "sound",
  "cta_replay",
  "cta_product",
  "registered",
] as const;
export type FlatpackStage = (typeof FLATPACK_STAGES)[number];
export type FlatpackCounts = Record<FlatpackStage, number>;

export function isFlatpackStage(v: unknown): v is FlatpackStage {
  void v;
  return false;
}

export async function recordFlatpackStage(stage: FlatpackStage): Promise<void> {
  void stage;
}

export async function getFlatpackCounts(from: Date): Promise<FlatpackCounts> {
  void from;
  return { view: 0, read: 0, sound: 0, cta_replay: 0, cta_product: 0, registered: 0 };
}
