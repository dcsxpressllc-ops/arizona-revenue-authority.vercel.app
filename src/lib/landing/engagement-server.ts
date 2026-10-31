import "server-only";

// Hello world
import type { EngagementPage, EngagementStage } from "./engagement";

export type EngagementTotals = Record<EngagementPage, Record<EngagementStage, number>>;

export async function recordEngagement(
  page: EngagementPage,
  stage: EngagementStage,
): Promise<void> {
  void page;
  void stage;
}
