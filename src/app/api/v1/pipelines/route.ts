import "server-only";

import { withApiAuth } from "@/lib/api/auth";
import { apiOk } from "@/lib/api/responses";
import { loadResolvedPipelines } from "@/lib/server/pipelines-service";

/**
 * GET /api/v1/pipelines: every pipeline with its ordered stages. Read-only.
 * The default pipeline (id "default") is always listed. Use these ids for
 * `stage` / `pipeline_id` on the deals endpoints.
 */
export const GET = withApiAuth(async ({ ctx }) => {
  const pipelines = await loadResolvedPipelines(ctx.subAccountId);
  return apiOk(ctx, {
    object: "list",
    data: pipelines.map((p) => ({
      id: p.id,
      object: "pipeline",
      name: p.name,
      stages: p.stages.map((s) => ({
        id: s.id,
        label: s.label,
        ...(s.terminal ? { terminal: s.terminal } : {}),
      })),
    })),
    has_more: false,
    url: "/v1/pipelines",
  });
});
