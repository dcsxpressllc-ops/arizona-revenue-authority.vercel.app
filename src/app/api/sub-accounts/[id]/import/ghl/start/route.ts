import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { publishCallback, qstashIsConfigured } from "@/lib/automations/qstash";
import { PIPELINE_STAGES, type PipelineStageId } from "@/types/deals";
import {
  createImportedPipeline,
  PipelineError,
} from "@/lib/server/pipelines-service";
import { type ImportJob } from "@/types/import";
import type {
  GhlPhase,
  GhlPipelineTarget,
} from "@/lib/import/ghl/transform";
import type { GhlImportConfig } from "@/types";

/**
 * Start a GHL migration. Admin only. Validates the connection and the
 * confirmed mapping, creates an `importJobs` record, and enqueues the first
 * QStash drain step (/api/import/ghl/step), which pages through contacts ->
 * opportunities -> notes.
 */

const CANONICAL_IDS = new Set<string>(PIPELINE_STAGES.map((s) => s.id));
/** Children resolve their parent contact's mapping, so order matters. */
const ENTITY_ORDER: GhlPhase[] = ["contacts", "opportunities", "notes"];

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  if (!qstashIsConfigured()) {
    return NextResponse.json(
      { error: "Imports require QStash, which isn't configured on this deployment." },
      { status: 503 },
    );
  }

  const db = getAdminDb();
  const subSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  if (!subSnap.exists) {
    return NextResponse.json({ error: "Sub-account not found" }, { status: 404 });
  }
  const sub = subSnap.data() ?? {};
  const agencyId = (sub.agencyId as string | undefined) ?? null;
  const cfg = sub.ghlImportConfig as GhlImportConfig | null | undefined;
  if (!cfg?.token || !cfg.locationId) {
    return NextResponse.json(
      { error: "Connect a GoHighLevel token before starting an import." },
      { status: 400 },
    );
  }
  if (!agencyId) {
    return NextResponse.json(
      { error: "Sub-account is missing tenancy metadata." },
      { status: 500 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const b = (body ?? {}) as Record<string, unknown>;

  // Defensive; the drain re-reads it.
  const rawMapping = (b.mapping ?? {}) as Record<string, unknown>;
  const defaultStageRaw = rawMapping.defaultStage;
  const defaultStage: PipelineStageId = CANONICAL_IDS.has(
    defaultStageRaw as string,
  )
    ? (defaultStageRaw as PipelineStageId)
    : "new";
  const defaultCurrency =
    typeof rawMapping.defaultCurrency === "string" &&
    rawMapping.defaultCurrency.length === 3
      ? (rawMapping.defaultCurrency as string).toUpperCase()
      : "USD";
  // If opted in, recreate each GHL pipeline here before the drain starts and
  // pass it a ghl-id -> leadstack-id map. Hitting the cap stops creating
  // pipelines; those opportunities fall back to the default pipeline and the
  // response says so.
  const pipelineMap: Record<string, GhlPipelineTarget> = {};
  const pipelineStageMap: Record<
    string,
    { pipelineId: string; stageId: string }
  > = {};
  const pipelineWarnings: string[] = [];
  if (b.createPipelines === true && Array.isArray(b.ghlPipelines)) {
    for (const raw of b.ghlPipelines as Array<Record<string, unknown>>) {
      const ghlId = typeof raw.id === "string" ? raw.id : "";
      const name = typeof raw.name === "string" ? raw.name.trim() : "";
      const stages = Array.isArray(raw.stages)
        ? (raw.stages as Array<Record<string, unknown>>).filter(
            (s) => typeof s.id === "string" && typeof s.name === "string",
          )
        : [];
      if (!ghlId || !name) continue;
      try {
        const { doc, stageIdByName } = await createImportedPipeline(
          subAccountId,
          { name, stageNames: stages.map((s) => s.name as string) },
        );
        const wonId =
          doc.stages.find((s) => s.terminal === "won")?.id ?? "won";
        const lostId =
          doc.stages.find((s) => s.terminal === "lost")?.id ?? "lost";
        pipelineMap[ghlId] = {
          id: doc.id,
          firstId: doc.stages[0]?.id ?? wonId,
          wonId,
          lostId,
        };
        for (const s of stages) {
          const lsStageId = stageIdByName.get(
            (s.name as string).toLowerCase(),
          );
          if (lsStageId) {
            pipelineStageMap[s.id as string] = {
              pipelineId: doc.id,
              stageId: lsStageId,
            };
          }
        }
      } catch (err) {
        const msg =
          err instanceof PipelineError ? err.message : "creation failed";
        pipelineWarnings.push(
          `Pipeline "${name}" wasn't recreated (${msg}) — its deals import onto the default pipeline instead.`,
        );
        if (err instanceof PipelineError && err.status === 409) break; // cap
      }
    }
  }

  const mapping = {
    stageMap:
      typeof rawMapping.stageMap === "object" && rawMapping.stageMap !== null
        ? rawMapping.stageMap
        : {},
    defaultStage,
    defaultCurrency,
    customFields:
      typeof rawMapping.customFields === "object" &&
      rawMapping.customFields !== null
        ? rawMapping.customFields
        : {},
    ...(Object.keys(pipelineMap).length > 0
      ? { pipelineMap, pipelineStageMap }
      : {}),
  };

  // Contacts always come along, since children resolve through them.
  const requested = Array.isArray(b.entities)
    ? ENTITY_ORDER.filter((e) => (b.entities as unknown[]).includes(e))
    : ENTITY_ORDER;
  const entities = requested.length > 0 ? requested : ENTITY_ORDER;
  if (!entities.includes("contacts")) entities.unshift("contacts");

  const ref = db.collection("importJobs").doc();
  const now = FieldValue.serverTimestamp();
  const job: Omit<ImportJob, "id"> & {
    ghlMapping: typeof mapping;
    ghlEntities: GhlPhase[];
  } = {
    agencyId,
    subAccountId,
    createdByUid: access.uid,
    source: "ghl",
    status: "running",
    totals: {},
    errors: [],
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
    ghlMapping: mapping,
    ghlEntities: entities,
  };
  await ref.set(job);

  const first = entities[0];
  const scheduled = await publishCallback({
    pathname: "/api/import/ghl/step",
    body: { jobId: ref.id, subAccountId, entity: first, cursor: null },
    delaySeconds: 0,
    deduplicationId: `ghlstep_${ref.id}_${first}_start`,
  });
  if (!scheduled) {
    await ref.update({
      status: "failed",
      finishedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return NextResponse.json(
      { error: "Couldn't enqueue the import. Please try again." },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    jobId: ref.id,
    pipelinesCreated: Object.keys(pipelineMap).length,
    ...(pipelineWarnings.length > 0 ? { pipelineWarnings } : {}),
  });
}
