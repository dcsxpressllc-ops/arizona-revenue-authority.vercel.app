"use client";

import { useMemo } from "react";
import { useSubAccount } from "@/context/sub-account-context";
import { resolvePipelineStages, type PipelineStage } from "@/types/deals";

/**
 * Pipeline stages with label/order overrides applied, from the already
 * subscribed sub-account doc. Canonical stages when there are no overrides,
 * so it's a drop-in for PIPELINE_STAGES.
 */
export function usePipelineStages(): PipelineStage[] {
  const { subAccount } = useSubAccount();
  return useMemo(
    () => resolvePipelineStages(subAccount?.pipelineStages),
    [subAccount?.pipelineStages],
  );
}
