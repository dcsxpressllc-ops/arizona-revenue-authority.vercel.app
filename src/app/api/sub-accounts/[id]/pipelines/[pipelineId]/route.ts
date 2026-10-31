import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import {
  deletePipeline,
  PipelineError,
  updatePipeline,
} from "@/lib/server/pipelines-service";

/**
 * Single-pipeline routes (sub-account admin).
 * PATCH { name?, stages?, order?, moveDealsTo? }: editing "default" without
 * a doc materializes it first. Removing an occupied stage without
 * moveDealsTo is a 409 with { code: "deals_in_removed_stages", counts,
 * total } so the UI can ask where to move them.
 * DELETE: only a non-default pipeline with zero deals (else 409).
 */

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string; pipelineId: string }> },
) {
  const { id, pipelineId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, id);
  if (access instanceof NextResponse) return access;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  try {
    await updatePipeline(id, pipelineId, {
      name: b.name,
      stages: b.stages,
      order: b.order,
      moveDealsTo: b.moveDealsTo,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof PipelineError) {
      // The occupied-stage conflict carries JSON in its message.
      try {
        const parsed = JSON.parse(err.message) as { code?: string };
        if (parsed.code === "deals_in_removed_stages") {
          return NextResponse.json(
            { error: "Some removed stages still have deals.", ...parsed },
            { status: err.status },
          );
        }
      } catch {
        // Plain-text PipelineError.
      }
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error(`[pipelines] update failed sa=${id} p=${pipelineId}`, err);
    return NextResponse.json(
      { error: "Couldn't update the pipeline." },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string; pipelineId: string }> },
) {
  const { id, pipelineId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, id);
  if (access instanceof NextResponse) return access;

  try {
    await deletePipeline(id, pipelineId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof PipelineError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error(`[pipelines] delete failed sa=${id} p=${pipelineId}`, err);
    return NextResponse.json(
      { error: "Couldn't delete the pipeline." },
      { status: 500 },
    );
  }
}
