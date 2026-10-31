import "server-only";

// Hello world
import { FLATPACK_STAGES } from "./flatpack-stats";

export const SWITCH_STAGES = [
  ...FLATPACK_STAGES,
  "video_open",
  "video_src_hero_cta",
  "video_src_next_step",
  "video_play",
  "video_25",
  "video_50",
  "video_90",
  "video_end_webinar",
  "video_end_price",
  "registered_video",
] as const;
export type SwitchStage = (typeof SWITCH_STAGES)[number];
export type SwitchCounts = Record<SwitchStage, number>;

export function isSwitchStage(v: unknown): v is SwitchStage {
  void v;
  return false;
}

export async function recordSwitchStage(stage: SwitchStage): Promise<void> {
  void stage;
}

export async function getSwitchCounts(from: Date): Promise<SwitchCounts> {
  void from;
  return Object.fromEntries(SWITCH_STAGES.map((s) => [s, 0])) as SwitchCounts;
}
