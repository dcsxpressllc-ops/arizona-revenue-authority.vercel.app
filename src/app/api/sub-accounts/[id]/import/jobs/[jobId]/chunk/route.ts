import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { writeImportChunk } from "@/lib/import/bulk-write";
import { applyChunkResultToJob } from "@/lib/import/job-progress";
import {
  IMPORT_ENTITIES,
  type ImportEntity,
  type ImportJob,
} from "@/types/import";

/**
 * POST .../import/jobs/[jobId]/chunk { entity, records }. Admin only.
 * Bulk-writes one chunk (<=500 records) through the shared engine, then adds
 * the counts to the job totals and appends a capped error sample. The
 * importer loops this for progress and backpressure.
 */

const MAX_RECORDS = 500;

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string; jobId: string }> },
) {
  const { id: subAccountId, jobId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const entity = b.entity as ImportEntity;
  if (!IMPORT_ENTITIES.includes(entity)) {
    return NextResponse.json(
      { error: `entity must be one of: ${IMPORT_ENTITIES.join(", ")}.` },
      { status: 400 },
    );
  }
  if (!Array.isArray(b.records)) {
    return NextResponse.json(
      { error: "`records` must be an array." },
      { status: 400 },
    );
  }
  if (b.records.length > MAX_RECORDS) {
    return NextResponse.json(
      { error: `At most ${MAX_RECORDS} records per chunk.` },
      { status: 400 },
    );
  }

  const db = getAdminDb();
  const jobRef = db.doc(`importJobs/${jobId}`);
  const jobSnap = await jobRef.get();
  if (!jobSnap.exists) {
    return NextResponse.json({ error: "Import job not found" }, { status: 404 });
  }
  const job = jobSnap.data() as ImportJob;
  if (job.subAccountId !== subAccountId) {
    return NextResponse.json({ error: "Import job not found" }, { status: 404 });
  }
  if (job.status === "completed" || job.status === "failed") {
    return NextResponse.json(
      { error: "This import job is already finished." },
      { status: 409 },
    );
  }

  // Webhooks and activities are suppressed for imports.
  const result = await writeImportChunk({
    subAccountId,
    agencyId: job.agencyId,
    createdByUid: access.uid,
    source: job.source,
    entity,
    records: b.records,
  });

  await applyChunkResultToJob(db, jobRef, entity, result);

  return NextResponse.json({
    ok: true,
    received: result.received,
    created: result.created,
    updated: result.updated,
    skipped: result.skipped,
    failed: result.failed,
    errors: result.errors,
  });
}
