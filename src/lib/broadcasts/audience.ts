import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import type { BroadcastAudienceFilter, BroadcastSendDoc } from "@/types";
import type { Contact } from "@/types/contacts";

/**
 * Resolve a broadcast's audience filter to recipients. Scoped by sub-account
 * first (drives the index), then the filter: all, tag, pipeline_stage, or the
 * delivered-but-unopened recipients of an earlier broadcast.
 *
 * Opted-out, bounced and no-email contacts are split out here so the confirm
 * dialog can show "N recipients, M skipped" without another round-trip, and
 * so totals.audienceSize matches exactly what gets queued.
 */
export interface ResolvedAudience {
  /** Passed pre-flight. */
  recipients: Contact[];
  /** Opted out, bounced or no email. */
  skipped: Array<{
    contact: Contact;
    reason: "opt_out" | "no_email" | "bounced";
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
  const contacts =
    filter.kind === "broadcast_unopened"
      ? await unopenedContacts(subAccountId, filter.broadcastId)
      : await filteredContacts(subAccountId, filter);

  const recipients: Contact[] = [];
  const skipped: ResolvedAudience["skipped"] = [];

  for (const contact of contacts) {
    // Territory first: excluded contacts are invisible, so they don't count as skipped.
    if (territoryFilter) {
      const tId = contact.territoryId ?? null;
      if (!tId || !territoryFilter.includes(tId)) continue;
    }
    if (contact.emailOptedOut) {
      skipped.push({ contact, reason: "opt_out" });
      continue;
    }
    if (contact.emailBouncedAt) {
      skipped.push({ contact, reason: "bounced" });
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

async function filteredContacts(
  subAccountId: string,
  filter: Exclude<BroadcastAudienceFilter, { kind: "broadcast_unopened" }>,
): Promise<Contact[]> {
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
  return snap.docs.map((doc) => ({
    id: doc.id,
    ...(doc.data() as Omit<Contact, "id">),
  }));
}

/**
 * Recipients of an earlier broadcast that were accepted (and delivered, when
 * the delivered event arrived) but never opened. Bounces and complaints are
 * out; current opt-out/bounce state is re-checked by the caller like any
 * other audience. The source broadcast must belong to this sub-account.
 */
async function unopenedContacts(
  subAccountId: string,
  broadcastId: string,
): Promise<Contact[]> {
  const db = getAdminDb();
  const broadcastSnap = await db.collection("broadcasts").doc(broadcastId).get();
  if (!broadcastSnap.exists) return [];
  if (broadcastSnap.data()?.subAccountId !== subAccountId) return [];

  // Only the fields the filter needs; a big broadcast has thousands of rows.
  const sends = await broadcastSnap.ref
    .collection("sends")
    .where("status", "==", "sent")
    .select("contactId", "openedAt", "clickedAt", "bouncedAt", "complainedAt")
    .get();
  const contactIds = sends.docs
    .map((d) => d.data() as Partial<BroadcastSendDoc>)
    .filter((s) => !s.openedAt && !s.clickedAt && !s.bouncedAt && !s.complainedAt)
    .map((s) => s.contactId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  // getAll is capped per call; chunk, and run a few chunks at a time so a
  // 25k re-send doesn't serialise hundreds of round trips.
  const CHUNK = 300;
  const CONCURRENCY = 5;
  const chunks: string[][] = [];
  for (let i = 0; i < contactIds.length; i += CHUNK) {
    chunks.push(contactIds.slice(i, i + CHUNK));
  }
  const contacts: Contact[] = [];
  for (let i = 0; i < chunks.length; i += CONCURRENCY) {
    const results = await Promise.all(
      chunks.slice(i, i + CONCURRENCY).map((ids) =>
        db.getAll(...ids.map((id) => db.collection("contacts").doc(id))),
      ),
    );
    for (const snaps of results) {
      for (const snap of snaps) {
        if (!snap.exists) continue;
        const data = snap.data() as Omit<Contact, "id">;
        // Belt and braces: a contact re-homed since the first send is dropped.
        if (data.subAccountId !== subAccountId) continue;
        contacts.push({ id: snap.id, ...data });
      }
    }
  }
  return contacts;
}
