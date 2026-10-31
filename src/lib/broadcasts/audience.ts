import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import type { BroadcastAudienceFilter } from "@/types";
import type { Contact } from "@/types/contacts";

/**
 * Resolve a broadcast's audience filter to recipients. Scoped by sub-account
 * first (drives the index), then the filter: all, tag, or pipeline_stage.
 *
 * Opted-out and no-email contacts are split out here so the confirm dialog can
 * show "N recipients, M skipped" without another round-trip, and so
 * totals.audienceSize matches exactly what gets queued.
 */
export interface ResolvedAudience {
  /** Passed pre-flight. */
  recipients: Contact[];
  /** Opted out or no email. */
  skipped: Array<{
    contact: Contact;
    reason: "opt_out" | "no_email";
  }>;
}

export async function resolveAudience(
  subAccountId: string,
  filter: BroadcastAudienceFilter,
  /**
   * null = unrestricted. A list limits recipients to those territories (scoped
   * collaborators can't blast outside theirs); [] means nobody. Excluded contacts
   * are dropped silently, not listed in `skipped`, so the caller never learns they exist.
   */
  territoryFilter: string[] | null = null,
): Promise<ResolvedAudience> {
  const db = getAdminDb();
  let query: FirebaseFirestore.Query = db
    .collection("contacts")
    .where("subAccountId", "==", subAccountId);

  if (filter.kind === "tag") {
    query = query.where("tags", "array-contains", filter.tag);
  } else if (filter.kind === "pipeline_stage") {
    query = query.where("pipelineStage", "==", filter.stage);
  }

  const snap = await query.get();

  const recipients: Contact[] = [];
  const skipped: ResolvedAudience["skipped"] = [];

  for (const doc of snap.docs) {
    const contact = { id: doc.id, ...(doc.data() as Omit<Contact, "id">) };
    // Territory first: excluded contacts are invisible, so they don't count as skipped.
    if (territoryFilter) {
      const tId = contact.territoryId ?? null;
      if (!tId || !territoryFilter.includes(tId)) continue;
    }
    if (contact.emailOptedOut) {
      skipped.push({ contact, reason: "opt_out" });
      continue;
    }
    if (!contact.email || !contact.email.includes("@")) {
      skipped.push({ contact, reason: "no_email" });
      continue;
    }
    recipients.push(contact);
  }

  return { recipients, skipped };
}
