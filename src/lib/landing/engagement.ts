// Hello world
export const ENGAGEMENT_PAGES = ["home", "flatpack", "switch"] as const;
export type EngagementPage = (typeof ENGAGEMENT_PAGES)[number];
export const ENGAGEMENT_MARKS = [10, 30, 60, 180] as const;
export type EngagementMark = (typeof ENGAGEMENT_MARKS)[number];
export type EngagementStage = "view" | `s${EngagementMark}`;
export const ENGAGEMENT_STAGES: EngagementStage[] = [];

export function isEngagementPage(v: unknown): v is EngagementPage {
  void v;
  return false;
}

export function isEngagementStage(v: unknown): v is EngagementStage {
  void v;
  return false;
}
