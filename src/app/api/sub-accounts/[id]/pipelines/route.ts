import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import {
  createPipeline,
  loadResolvedPipelines,
  PipelineError,
} from "@/lib/server/pipelines-service";

/**
 * Pipeline collection routes (sub-account admin).
 * GET: resolved list (docs + the virtual default). The UI usually reads the
 * subcollection directly; this is for an authoritative refresh.
 * POST { name, stages: [{label, tone?, terminal?}] }: create. Validation
 * (2-12 stages, exactly one Won and one Lost, caps) is in the service.
 */

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const access = await requireSubAccountAdmin(request, id);
  if (access instanceof NextResponse) return access;
  const pipelines = await loadResolvedPipelines(id);
  return NextResponse.json({ ok: true, pipelines });
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
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
    const doc = await createPipeline(id, { name: b.name, stages: b.stages });
    return NextResponse.json({ ok: true, pipeline: doc });
  } catch (err) {
    if (err instanceof PipelineError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error(`[pipelines] create failed sa=${id}`, err);
    return NextResponse.json(
      { error: "Couldn't create the pipeline." },
      { status: 500 },
    );
  }
}
