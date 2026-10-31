"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { collection, onSnapshot } from "firebase/firestore";
import { useSubAccount } from "@/context/sub-account-context";
import { getFirebaseDb } from "@/lib/firebase/client";
import {
  dealPipelineId,
  getPipeline,
  resolvePipelineList,
} from "@/lib/pipelines/resolve";
import { getStage, type PipelineStage } from "@/types/deals";
import type { PipelineDoc, ResolvedPipeline } from "@/types/pipelines";

/**
 * Resolved pipelines for the active sub-account, default first. One
 * subcollection listener; when there's no pipelines/default doc the default
 * (canonical six + rename/reorder overrides) is synthesized client-side, so
 * an uncustomized sub-account needs no extra docs. usePipelineStages()
 * remains as a default-pipeline-only shim.
 */
export function usePipelines(): {
  pipelines: ResolvedPipeline[];
  hydrated: boolean;
} {
  const { subAccountId, subAccount } = useSubAccount();
  const [docs, setDocs] = useState<PipelineDoc[]>([]);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (!subAccountId) return;
    const unsub = onSnapshot(
      collection(getFirebaseDb(), `subAccounts/${subAccountId}/pipelines`),
      (snap) => {
        setDocs(
          snap.docs.map((d) => ({ ...(d.data() as PipelineDoc), id: d.id })),
        );
        setHydrated(true);
      },
      // Permission/absence errors fail open to the virtual default.
      () => setHydrated(true),
    );
    return () => unsub();
  }, [subAccountId]);

  const pipelines = useMemo(
    () =>
      resolvePipelineList({
        docs,
        legacyOverrides: subAccount?.pipelineStages,
      }),
    [docs, subAccount?.pipelineStages],
  );

  return { pipelines, hydrated };
}

/**
 * Resolves a deal's stage against its own pipeline. Use instead of
 * getStage(deal.stageId, usePipelineStages()) wherever deals from several
 * pipelines render together.
 */
export function useDealStageResolver(): (deal: {
  pipelineId?: string | null;
  stageId: string;
}) => PipelineStage {
  const { pipelines } = usePipelines();
  return useCallback(
    (deal) =>
      getStage(deal.stageId, getPipeline(pipelines, dealPipelineId(deal)).stages),
    [pipelines],
  );
}
