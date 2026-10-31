import "server-only";

import { parsePhoneNumberFromString } from "libphonenumber-js";
import { Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import type { BroadcastAudienceFilter, VoiceCampaignSuppression } from "@/types";
import type { Contact } from "@/types/contacts";

/** Why a contact was dropped before dialling. */
export type VoiceAudienceSkipReason =
  | "opted_out"
  | "no_phone"
  | "recently_called"
  | "suppressed_tag"
  | "prior_campaign";

/**
 * Voice campaign audience, like lib/broadcasts/audience.ts but filtering on
 * phone: skipped only for no valid number or a voice opt-out. The per-call
 * compliance checks (window, caps, country, scrub) depend on time and state,
 * so they run later in the step callback.
 */
export interface ResolvedVoiceAudience {
  recipients: Contact[];
  skipped: Array<{
    contact: Contact;
    reason: VoiceAudienceSkipReason;
  }>;
}

export async function resolveVoiceAudience(
  subAccountId: string,
  filter: BroadcastAudienceFilter,
  /** Same semantics as the broadcast resolver. */
  territoryFilter: string[] | null = null,
  /** Recently-called / tag / prior-campaign suppression. null = only opt-out and phone validity. */
  suppression: VoiceCampaignSuppression | null = null,
): Promise<ResolvedVoiceAudience> {
  const db = getAdminDb();
  let query: FirebaseFirestore.Query = db
    .collection("contacts")
    .where("subAccountId", "==", subAccountId);

  if (filter.kind === "tag") {
    query = query.where("tags", "array-contains", filter.tag);
  } else if (filter.kind === "pipeline_stage") {
    query = query.where("pipelineStage", "==", filter.stage);
  }

  const recentCutoff =
    suppression?.recentDays && suppression.recentDays > 0
      ? Timestamp.fromMillis(
          Date.now() - suppression.recentDays * 24 * 60 * 60 * 1000,
        )
      : null;
  const excludeTag = suppression?.excludeTag?.trim() || null;

  // Prior-campaign exclusion: that campaign's recipient contact ids.
  let priorIds: Set<string> | null = null;
  if (suppression?.excludeCampaignId) {
    const priorSnap = await db
      .collection("voiceCampaigns")
      .doc(suppression.excludeCampaignId)
      .collection("recipients")
      .get();
    priorIds = new Set(priorSnap.docs.map((d) => d.id));
  }

  const snap = await query.get();

  const recipients: Contact[] = [];
  const skipped: ResolvedVoiceAudience["skipped"] = [];

  for (const doc of snap.docs) {
    const contact = { id: doc.id, ...(doc.data() as Omit<Contact, "id">) };
    if (territoryFilter) {
      const tId = contact.territoryId ?? null;
      if (!tId || !territoryFilter.includes(tId)) continue;
    }
    if (contact.voiceOptedOut === true) {
      skipped.push({ contact, reason: "opted_out" });
      continue;
    }
    const parsed = contact.phone
      ? parsePhoneNumberFromString(contact.phone)
      : null;
    if (!parsed || !parsed.isValid()) {
      skipped.push({ contact, reason: "no_phone" });
      continue;
    }
    // Suppression
    if (priorIds && priorIds.has(contact.id)) {
      skipped.push({ contact, reason: "prior_campaign" });
      continue;
    }
    if (excludeTag && (contact.tags ?? []).includes(excludeTag)) {
      skipped.push({ contact, reason: "suppressed_tag" });
      continue;
    }
    if (recentCutoff) {
      const last = contact.lastOutboundCallAt as Timestamp | null | undefined;
      if (
        last &&
        typeof (last as Timestamp).toMillis === "function" &&
        (last as Timestamp).toMillis() >= recentCutoff.toMillis()
      ) {
        skipped.push({ contact, reason: "recently_called" });
        continue;
      }
    }
    recipients.push(contact);
  }

  return { recipients, skipped };
}
