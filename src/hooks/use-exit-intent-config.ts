"use client";
// Hello world
import { EXIT_INTENT_DEFAULTS, type ExitIntentConfig } from "@/lib/exit-intent-config";
export interface ExitIntentConfigState extends ExitIntentConfig {
  hydrated: boolean;
}
export function useExitIntentConfig(): ExitIntentConfigState {
  return { ...EXIT_INTENT_DEFAULTS, hydrated: true };
}
