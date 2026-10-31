import "server-only";

import type { Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getStage, type Deal, type PipelineStage } from "@/types/deals";
import { dealPipelineId, getPipeline } from "@/lib/pipelines/resolve";
import { loadResolvedPipelines } from "@/lib/server/pipelines-service";
import type { Contact } from "@/types/contacts";

const MAX_DEALS_INCLUDED = 3;

/**
 * Compact contact context for the AI system prompt: identity basics and
 * active deals (title, stage, value, age).
 *
 * Only include facts the customer already knows about their own account.
 * Operator notes and tags are deliberately excluded: notes are written for the
 * operator ("poor condition, charge him more") and also collect form and
 * enrichment data, and telling the model not to recite them is no guarantee.
 * Bringing notes back would need a per-note shareable flag, not a toggle.
 *
 * Kept small since it's paid for on every call; prefer recent over complete.
 * null when there's nothing worth including.
 */
export async function buildContactContextBlock(
  contact: Contact,
): Promise<string | null> {
  const db = getAdminDb();

  const dealsSnap = await db
    .collection("deals")
    .where("contactId", "==", contact.id)
    .where("subAccountId", "==", contact.subAccountId)
    .orderBy("updatedAt", "desc")
    .limit(MAX_DEALS_INCLUDED)
    .get()
    .catch(() => null);

  const deals: Deal[] = dealsSnap
    ? dealsSnap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<Deal, "id">),
      }))
    : [];

  // Resolve stages against each deal's own pipeline so a custom-pipeline Won
  // deal doesn't read as an active "New" one. Skip the read when there are no deals.
  const pipelines =
    deals.length > 0
      ? await loadResolvedPipelines(contact.subAccountId).catch(() => [])
      : [];
  const stageOf = (d: Deal): PipelineStage =>
    getStage(d.stageId, getPipeline(pipelines, dealPipelineId(d)).stages);

  const lines: string[] = [];

  // Identity
  const identityBits: string[] = [];
  if (contact.name?.trim()) identityBits.push(`Name: ${contact.name.trim()}`);
  if (contact.company?.trim())
    identityBits.push(`Company: ${contact.company.trim()}`);
  // "website" is the default for unattributed form submissions, so it's noise.
  if (contact.source && contact.source !== "website") {
    identityBits.push(`Source: ${contact.source}`);
  }

  // Campaign only; the rest of the UTMs aren't useful in conversation.
  const attribution = contact.attribution;
  if (attribution?.utmCampaign) {
    identityBits.push(`Ad campaign: ${attribution.utmCampaign}`);
  }

  if (identityBits.length > 0) {
    lines.push(...identityBits);
  }

  // Active (non-terminal) deals
  const activeDeals = deals.filter((d) => {
    const stage = stageOf(d);
    return stage.terminal !== "won" && stage.terminal !== "lost";
  });

  if (activeDeals.length > 0) {
    const dealLines = activeDeals.map((d) => {
      const stage = stageOf(d);
      const ageDays = ageInDays(d.stageChangedAt ?? d.createdAt);
      const value = d.value
        ? `${d.currency || "USD"} ${d.value.toLocaleString()}`
        : "no value set";
      const age = ageDays !== null ? `${ageDays}d in stage` : "";
      return `  - "${d.title}" — ${stage.label}${age ? `, ${age}` : ""}, ${value}`;
    });
    lines.push("Active deals:");
    lines.push(...dealLines);
  }

  // Most recent won/lost deal only
  const lastWon = deals.find((d) => stageOf(d).terminal === "won");
  if (lastWon) {
    lines.push(
      `Past sale: "${lastWon.title}" (${lastWon.currency || "USD"} ${lastWon.value.toLocaleString()})`,
    );
  }

  if (lines.length === 0) return null;

  return [
    "## Context about this contact (for your awareness only)",
    ...lines,
    "",
    "Use this context to inform your replies but do not recite it back unsolicited. If the customer hasn't mentioned a topic, don't bring it up.",
  ].join("\n");
}

function ageInDays(value: Deal["stageChangedAt"]): number | null {
  if (!value) return null;
  const ts = value as Timestamp;
  if (typeof ts.toDate !== "function") return null;
  const diff = Date.now() - ts.toDate().getTime();
  if (diff < 0) return 0;
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

