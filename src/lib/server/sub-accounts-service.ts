import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { seedDefaultTemplates } from "@/lib/automations/seed-templates";
import { GLOBAL_TERRITORY_ID } from "@/types";

/**
 * Sub-account creation, shared by POST /api/agency/sub-accounts and the AI Suite
 * create_sub_account capability so gates, counter, membership and template
 * seeding happen in one transaction. Callers do auth and validation.
 */

const STARTING_ACCOUNT_NUMBER = 1000;

export interface CreateSubAccountInput {
  agencyId: string;
  /** Agency owner doing the create. */
  uid: string;
  email: string;
  displayName: string;
  /** Validated by the caller. */
  name: string;
  /** Validated slug (lowercase/numbers/dashes), or "" to derive one. */
  slug: string;
  /** IANA timezone or "UTC". */
  timezone: string;
  accountContact: {
    name: string | null;
    email: string | null;
    phone: string | null;
  } | null;
}

export interface CreateSubAccountResult {
  subAccountId: string;
  accountNumber: number;
  name: string;
  agencyId: string;
}

/**
 * Collections whose docs mean the sub-account has really been used. Seeded data
 * (owner membership, welcome templates, counters, userMemberships) is left out,
 * so a fresh test sub-account still counts as clean. Labels are shown when a
 * delete is blocked.
 */
const USAGE_COLLECTIONS: ReadonlyArray<{ collection: string; label: string }> =
  [
    { collection: "contacts", label: "contacts" },
    { collection: "deals", label: "deals" },
    { collection: "tasks", label: "tasks" },
    { collection: "events", label: "calendar events" },
    { collection: "forms", label: "forms" },
    { collection: "quotes", label: "quotes / invoices" },
    { collection: "products", label: "products" },
    { collection: "automations", label: "automations" },
    { collection: "broadcasts", label: "broadcasts" },
    { collection: "socialPosts", label: "social posts" },
    { collection: "voiceCampaigns", label: "voice campaigns" },
  ];

/** Sub-account still has real data. `blockers` lists labels like
 *  ["contacts", "deals"] for the route to show. */
export class SubAccountNotEmptyError extends Error {
  readonly blockers: string[];
  constructor(blockers: string[]) {
    super(`Sub-account is not empty: ${blockers.join(", ")}`);
    this.name = "SubAccountNotEmptyError";
    this.blockers = blockers;
  }
}

/** Missing, or not in this agency. */
export class SubAccountNotFoundError extends Error {
  constructor() {
    super("Sub-account not found");
    this.name = "SubAccountNotFoundError";
  }
}

/**
 * Delete an unused sub-account. Throws SubAccountNotEmptyError if any
 * USAGE_COLLECTIONS doc exists, so real CRM data is never removed here.
 * Removes seeded templates and members' userMemberships entries, then
 * recursively deletes subAccounts/{id}. The account-number counter is left
 * alone so numbers are never reused.
 */
export async function deleteSubAccountForAgency(input: {
  agencyId: string;
  subAccountId: string;
}): Promise<void> {
  const { agencyId, subAccountId } = input;
  const db = getAdminDb();

  const subRef = db.doc(`subAccounts/${subAccountId}`);
  const subSnap = await subRef.get();
  // Other agencies' docs read as "not found" so we don't leak that they exist.
  if (!subSnap.exists || subSnap.data()?.agencyId !== agencyId) {
    throw new SubAccountNotFoundError();
  }

  const { IMPORT_SOURCE, setWorkspaceImportAllowed } = await import(
    "@/lib/google/calendar-import"
  );

  // One limit(1) probe per collection, in parallel.
  const probes = await Promise.all(
    USAGE_COLLECTIONS.map(async ({ collection, label }) => {
      const scoped = db
        .collection(collection)
        .where("subAccountId", "==", subAccountId);
      const snap = await scoped.limit(1).get();
      if (snap.empty) return null;
      // Imported Google events are a disposable mirror, never "real data".
      if (collection === "events") {
        // One read-only transaction so both counts come from the same snapshot.
        const [all, imported] = await db.runTransaction(
          (tx) =>
            Promise.all([
              tx.get(scoped.count()),
              tx.get(scoped.where("source", "==", IMPORT_SOURCE).count()),
            ]),
          { readOnly: true }
        );
        if (all.data().count === imported.data().count) return null;
      }
      return label;
    })
  );
  const blockers = probes.filter((l): l is string => l !== null);
  if (blockers.length > 0) throw new SubAccountNotEmptyError(blockers);

  // Only once the delete is certain: a refused delete must leave import on.
  await setWorkspaceImportAllowed(subAccountId, false);

  // Read members before the recursive delete so we can prune userMemberships.
  const membersSnap = await subRef.collection("subAccountMembers").get();
  const memberUids = membersSnap.docs.map((d) => d.id);

  const templatesSnap = await db
    .collection("message_templates")
    .where("subAccountId", "==", subAccountId)
    .get();

  const batch = db.batch();
  for (const uid of memberUids) {
    batch.delete(db.doc(`userMemberships/${uid}/subAccounts/${subAccountId}`));
  }
  for (const doc of templatesSnap.docs) batch.delete(doc.ref);
  await batch.commit();

  // Doc plus every subcollection (members, counters, aiSuiteUsage, aiAgent,
  // apiKeys, website, ...).
  await db.recursiveDelete(subRef);
}

export async function createSubAccountForAgency(
  input: CreateSubAccountInput
): Promise<CreateSubAccountResult> {
  const {
    agencyId,
    uid,
    email,
    displayName,
    name,
    slug,
    timezone,
    accountContact,
  } = input;

  const db = getAdminDb();
  const subRef = db.collection("subAccounts").doc();
  const subAccountId = subRef.id;
  const counterRef = db.doc(`agencies/${agencyId}/counters/subAccount`);

  // Transactional so concurrent creates can't share an account number. Agencies
  // without a counter doc yet start at 1000.
  const accountNumber = await db.runTransaction<number>(async (tx) => {
    const counterSnap = await tx.get(counterRef);
    const current = counterSnap.exists
      ? ((counterSnap.data()?.next as number | undefined) ??
        STARTING_ACCOUNT_NUMBER)
      : STARTING_ACCOUNT_NUMBER;
    tx.set(counterRef, { next: current + 1 });

    tx.set(subRef, {
      id: subAccountId,
      agencyId,
      accountNumber: current,
      name,
      slug: slug || subAccountId.slice(0, 8),
      status: "active",
      timezone,
      createdByUid: uid,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      twilioConfig: null,
      resendConfig: null,
      emailDomainEnabledByAgency: false,
      outboundVoiceEnabledByAgency: false,
      whatsappEnabledByAgency: false,
      // These AI channels predate agency gating, so they default on; the agency can
      // turn them off to control cost (see gates.ts).
      smsAgentEnabledByAgency: true,
      webChatEnabledByAgency: true,
      inboundVoiceEnabledByAgency: true,
      metaInboxEnabledByAgency: false,
      metaAgentEnabledByAgency: false,
      aiOutboundSmsEnabledByAgency: false,
      websiteEnabledByAgency: false,
      communityEnabledByAgency: false,
      getLeadsEnabledByAgency: false,
      missedCallTextBackEnabledByAgency: false,
      // Labs is opt-in per client.
      labsEnabledByAgency: false,
      // Monitors spend AI credits, so they are opt-in too.
      agentsEnabledByAgency: false,
      // A money rail is always an explicit per-client decision.
      paymentsEnabledByAgency: false,
      stripeConnectionMeta: null,
      // Same for an external webinar integration.
      webinar1EnabledByAgency: false,
      webVoiceEnabledByAgency: false,
      sellOnlineEnabledByAgency: false,
      webinar1ConnectionMeta: null,
      // Opt-in per sub-account from the Manage dialog.
      aiSuiteEnabledByAgency: false,
      metaConfig: null,
      bookingConfig: null,
      sendWindow: null,
      bookingLink: null,
      replyToEmail: null,
      automationsPaused: false,
      accountContact,
    });

    // The owner is implicitly admin everywhere, but the membership doc makes the
    // switcher index pick it up.
    tx.set(subRef.collection("subAccountMembers").doc(uid), {
      uid,
      subAccountId,
      agencyId,
      role: "admin",
      status: "active",
      email,
      displayName,
      addedAt: FieldValue.serverTimestamp(),
      addedByUid: uid,
      assignedTerritoryIds: [GLOBAL_TERRITORY_ID],
    });

    tx.set(db.doc(`userMemberships/${uid}/subAccounts/${subAccountId}`), {
      subAccountId,
      agencyId,
      accountNumber: current,
      role: "admin",
      name,
      addedAt: FieldValue.serverTimestamp(),
    });

    // Welcome email + SMS templates as defaults.
    seedDefaultTemplates(db, (ref, data) => tx.set(ref, data), {
      agencyId,
      subAccountId,
      createdByUid: uid,
    });

    return current;
  });

  return { subAccountId, accountNumber, name, agencyId };
}
