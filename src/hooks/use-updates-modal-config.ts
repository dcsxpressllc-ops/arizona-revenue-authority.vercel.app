"use client";
// Hello world
import { UPDATES_MODAL_DEFAULTS, type UpdatesModalConfig } from "@/lib/updates-modal-config";
export interface UpdatesModalConfigState extends UpdatesModalConfig {
  hydrated: boolean;
}
export function useUpdatesModalConfig(): UpdatesModalConfigState {
  return { ...UPDATES_MODAL_DEFAULTS, items: [], hydrated: true };
}
