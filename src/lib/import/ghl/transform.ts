/**
 * GoHighLevel -> LeadStack transformers. Pure (no network, no Firestore) so
 * they're fixture-testable without a GHL account. They produce the chunk
 * records the public API and bulk-write engine validate, carrying
 * `external_id` + `contact_external_id` so imports are idempotent and
 * relationships resolve.
 *
 * Endpoint paths live in `client.ts`; these depend only on the response
 * shapes below, fixtured in `fixtures.ts`.
 */

import type { PipelineStageId } from "@/types/deals";
import type { CustomFieldType } from "@/types/custom-fields";

// GHL response shapes (the subset we use)

export interface GhlCustomFieldValue {
  id: string;
  value: unknown;
}

export interface GhlContact {
  id: string;
  contactName?: string;
  firstName?: string;
  lastName?: string;
  name?: string;
  email?: string;
  phone?: string;
  companyName?: string;
  address1?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  tags?: string[];
  source?: string;
  customFields?: GhlCustomFieldValue[];
}

export interface GhlOpportunity {
  id: string;
  name?: string;
  contactId?: string;
  pipelineId?: string;
  pipelineStageId?: string;
  /** Overrides the stage map for terminal states. */
  status?: "open" | "won" | "lost" | "abandoned" | string;
  monetaryValue?: number;
  customFields?: GhlCustomFieldValue[];
}

export interface GhlNote {
  id: string;
  body?: string;
  contactId?: string;
  dateAdded?: string;
}

export interface GhlPipeline {
  id: string;
  name: string;
  stages: { id: string; name: string }[];
}

export interface GhlCustomFieldDef {
  id: string;
  name: string;
  fieldKey?: string;
  dataType?: string;
  /** For SINGLE_OPTIONS / MULTIPLE_OPTIONS etc. */
  picklistOptions?: string[];
  /** "contact" or "opportunity". */
  model?: string;
}

// Mapping config, built in the wizard's mapping step

/** Import order. `opportunities` are written as `deals`; contacts/notes map 1:1. */
export type GhlPhase = "contacts" | "opportunities" | "notes";

/** GHL stage id -> one of the 6 canonical stages. */
export type GhlStageMap = Record<string, PipelineStageId>;

export interface GhlCustomFieldMapEntry {
  ghlId: string;
  ghlName: string;
  /** null = skip this field. */
  leadstackKey: string | null;
}

/** The LeadStack pipeline recreated for one GHL pipeline. */
export interface GhlPipelineTarget {
  id: string;
  /** Fallback for unmapped GHL stages. */
  firstId: string;
  wonId: string;
  lostId: string;
}

export interface GhlImportMapping {
  stageMap: GhlStageMap;
  defaultStage: PipelineStageId;
  /** GHL rarely returns one. */
  defaultCurrency: string;
  /** Keyed by GHL field id; contacts and deals share one map. */
  customFields: Record<string, GhlCustomFieldMapEntry>;
  /** GHL pipeline id -> recreated pipeline. Absent: everything goes on the default pipeline. */
  pipelineMap?: Record<string, GhlPipelineTarget>;
  pipelineStageMap?: Record<string, { pipelineId: string; stageId: string }>;
}

// Transformers (GHL object -> chunk record)

function joinAddress(c: GhlContact): string {
  return [c.address1, c.city, c.state, c.postalCode, c.country]
    .map((s) => (typeof s === "string" ? s.trim() : ""))
    .filter(Boolean)
    .join(", ");
}

function contactName(c: GhlContact): string {
  const full = [c.firstName, c.lastName]
    .filter((s) => typeof s === "string" && s.trim())
    .join(" ")
    .trim();
  return (
    c.contactName?.trim() ||
    full ||
    c.name?.trim() ||
    c.email?.trim() ||
    "Unknown contact"
  );
}

/** GHL customFields[] -> { leadstackKey: value }, skipping unmapped. */
function mapCustomFields(
  fields: GhlCustomFieldValue[] | undefined,
  map: Record<string, GhlCustomFieldMapEntry>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields ?? []) {
    const entry = map[f.id];
    if (entry?.leadstackKey) out[entry.leadstackKey] = f.value;
  }
  return out;
}

export interface ContactChunkRecord {
  external_id: string;
  name: string;
  email: string;
  phone: string;
  company: string;
  address: string;
  source: string;
  tags: string[];
  custom_fields: Record<string, unknown>;
}

export function ghlContactToChunk(
  c: GhlContact,
  mapping: GhlImportMapping,
): ContactChunkRecord {
  return {
    external_id: c.id,
    name: contactName(c),
    email: c.email?.trim() ?? "",
    phone: c.phone?.trim() ?? "",
    company: c.companyName?.trim() ?? "",
    address: joinAddress(c),
    source: c.source?.trim() ?? "",
    tags: Array.isArray(c.tags) ? c.tags.filter((t) => typeof t === "string") : [],
    custom_fields: mapCustomFields(c.customFields, mapping.customFields),
  };
}

export interface DealChunkRecord {
  external_id: string;
  contact_external_id: string;
  title: string;
  value: number;
  currency: string;
  /** null = default pipeline. */
  pipeline_id: string | null;
  stage: PipelineStageId;
  custom_fields: Record<string, unknown>;
}

/**
 * GHL's terminal status beats the stage map (won -> won, lost/abandoned ->
 * lost); otherwise the mapped stage, else `defaultStage`.
 */
export function resolveOpportunityStage(
  o: GhlOpportunity,
  mapping: GhlImportMapping,
): PipelineStageId {
  if (o.status === "won") return "won";
  if (o.status === "lost" || o.status === "abandoned") return "lost";
  const mapped = o.pipelineStageId
    ? mapping.stageMap[o.pipelineStageId]
    : undefined;
  return mapped ?? mapping.defaultStage;
}

/**
 * If the operator chose pipeline import and this opportunity's pipeline was
 * recreated, it goes there: terminal status -> that pipeline's Won/Lost, else
 * the mapped stage, else its first stage. Anything else uses the default pipeline.
 */
export function resolveOpportunityPlacement(
  o: GhlOpportunity,
  mapping: GhlImportMapping,
): { pipelineId: string | null; stage: PipelineStageId } {
  const target = o.pipelineId
    ? mapping.pipelineMap?.[o.pipelineId]
    : undefined;
  if (target) {
    if (o.status === "won") {
      return { pipelineId: target.id, stage: target.wonId };
    }
    if (o.status === "lost" || o.status === "abandoned") {
      return { pipelineId: target.id, stage: target.lostId };
    }
    const mapped = o.pipelineStageId
      ? mapping.pipelineStageMap?.[o.pipelineStageId]
      : undefined;
    if (mapped && mapped.pipelineId === target.id) {
      return { pipelineId: target.id, stage: mapped.stageId };
    }
    return { pipelineId: target.id, stage: target.firstId };
  }
  return { pipelineId: null, stage: resolveOpportunityStage(o, mapping) };
}

export function ghlOpportunityToChunk(
  o: GhlOpportunity,
  mapping: GhlImportMapping,
): DealChunkRecord {
  const placement = resolveOpportunityPlacement(o, mapping);
  return {
    external_id: o.id,
    contact_external_id: o.contactId ?? "",
    title: o.name?.trim() || "Untitled deal",
    value:
      typeof o.monetaryValue === "number" && Number.isFinite(o.monetaryValue)
        ? o.monetaryValue
        : 0,
    currency: mapping.defaultCurrency || "USD",
    pipeline_id: placement.pipelineId,
    stage: placement.stage,
    custom_fields: mapCustomFields(o.customFields, mapping.customFields),
  };
}

export interface NoteChunkRecord {
  external_id: string;
  contact_external_id: string;
  content: string;
  created_at: string | null;
}

export function ghlNoteToChunk(n: GhlNote): NoteChunkRecord {
  return {
    external_id: n.id,
    contact_external_id: n.contactId ?? "",
    content: n.body?.trim() ?? "",
    created_at: typeof n.dateAdded === "string" ? n.dateAdded : null,
  };
}

// Auto-suggested mappings (pre-filled in the wizard for review)

/** Keyword match on the stage name, best-effort. */
export function suggestStageId(stageName: string): PipelineStageId {
  const n = stageName.toLowerCase();
  if (/(won|closed.?won|signed|sold)/.test(n)) return "won";
  if (/(lost|abandon|dead|closed.?lost|disqualif)/.test(n)) return "lost";
  if (/(propos|quote|estimate|contract|negotiat)/.test(n)) return "proposal";
  if (/(qualif|discovery|demo|meeting)/.test(n)) return "qualified";
  if (/(contact|reach|follow|engaged|nurtur)/.test(n)) return "contacted";
  return "new";
}

export function suggestStageMap(pipelines: GhlPipeline[]): GhlStageMap {
  const map: GhlStageMap = {};
  for (const p of pipelines) {
    for (const s of p.stages ?? []) {
      map[s.id] = suggestStageId(s.name ?? "");
    }
  }
  return map;
}

export function ghlDataTypeToCustomFieldType(
  dataType: string | undefined,
): CustomFieldType {
  switch ((dataType ?? "").toUpperCase()) {
    case "NUMERICAL":
    case "MONETARY":
      return "number";
    case "DATE":
      return "date";
    case "PHONE":
      return "phone";
    case "EMAIL":
      return "email";
    case "SINGLE_OPTIONS":
    case "RADIO":
    case "DROPDOWN":
      return "dropdown";
    case "MULTIPLE_OPTIONS":
    case "CHECKBOX_MULTI":
      return "multiselect";
    case "CHECKBOX":
      return "checkbox";
    case "URL":
      return "url";
    default:
      return "text";
  }
}

export interface SuggestedCustomField {
  ghlId: string;
  ghlName: string;
  entity: "contact" | "deal";
  label: string;
  type: CustomFieldType;
  options: string[];
}

export function suggestCustomFields(
  defs: GhlCustomFieldDef[],
): SuggestedCustomField[] {
  return defs.map((d) => ({
    ghlId: d.id,
    ghlName: d.name,
    entity: (d.model ?? "").toLowerCase() === "opportunity" ? "deal" : "contact",
    label: d.name,
    type: ghlDataTypeToCustomFieldType(d.dataType),
    options: Array.isArray(d.picklistOptions) ? d.picklistOptions : [],
  }));
}
