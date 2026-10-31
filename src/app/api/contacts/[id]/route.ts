import "server-only";

import { NextResponse } from "next/server";
import { getAdminAuth, getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import {
  emitContactDeleted,
  updateContactServerSide,
  type UpdateContactPatch,
} from "@/lib/server/contacts-service";
import { loadCustomFieldDefs } from "@/lib/custom-fields/load-defs";
import { validateCustomFieldValues } from "@/lib/custom-fields/validation";
import { normalizePhoneLenient } from "@/lib/contacts/phone";
import type { Contact } from "@/types/contacts";
import type { MemberStatus, Role } from "@/types";

/**
 * Contact delete, only when nothing else points at it. Admin or agency owner
 * only (same as the `contacts/{id}` delete rule).
 *
 * 409 with a `blockers` list (type + count) while linked to a deal, task,
 * event, quote, web-chat conversation or voice call. GET runs the same check
 * as a dry run for the confirm modal. Form submissions cascade instead of
 * blocking, since there's no other way to delete them.
 */

interface CallerClaims {
  status?: MemberStatus;
  agencyId?: string | null;
  agencyRole?: "owner" | "staff" | null;
  role?: Role;
}

async function readCaller(request: Request): Promise<
  | { uid: string; email: string; claims: CallerClaims }
  | NextResponse
> {
  const uid = request.headers.get("x-user-uid");
  if (!uid) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const auth = getAdminAuth();
  const record = await auth.getUser(uid).catch(() => null);
  if (!record) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const claims = (record.customClaims ?? {}) as CallerClaims;
  if (claims.status !== "active") {
    return NextResponse.json({ error: "Account inactive" }, { status: 403 });
  }
  return { uid, email: record.email ?? "", claims };
}

function str(v: unknown, max = 500): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

/**
 * Update plain contact fields and emit `contact.updated`. Any active member
 * may edit. Territory moves go through the territory fan-out endpoint instead.
 */
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const db = getAdminDb();
  const snap = await db.doc(`contacts/${id}`).get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }
  const data = snap.data() as Omit<Contact, "id">;

  const access = await requireSubAccountMember(request, data.subAccountId);
  if (access instanceof NextResponse) return access;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const patch: UpdateContactPatch = {};
  if (typeof body.name === "string") patch.name = body.name.trim().slice(0, 200);
  if (typeof body.email === "string") patch.email = str(body.email);
  if (typeof body.phone === "string") {
    // Lenient E.164 using the workspace's default country (extra read only when phone changes).
    const rawPhone = str(body.phone);
    if (rawPhone) {
      const subSnap = await db.doc(`subAccounts/${data.subAccountId}`).get();
      patch.phone = normalizePhoneLenient(
        rawPhone,
        (subSnap.data()?.defaultPhoneCountry as string) ?? null,
      );
    } else {
      patch.phone = "";
    }
  }
  if (typeof body.company === "string") patch.company = str(body.company);
  if (typeof body.address === "string") patch.address = str(body.address);
  if (typeof body.source === "string") patch.source = str(body.source);
  if (Array.isArray(body.tags)) {
    patch.tags = body.tags
      .filter((t): t is string => typeof t === "string")
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 50);
  }
  if (body.pipelineStage === null || typeof body.pipelineStage === "string") {
    patch.pipelineStage =
      typeof body.pipelineStage === "string" ? body.pipelineStage : null;
  }
  // customFields replaces the whole map, validated against live definitions.
  if (body.customFields !== undefined) {
    const defs = await loadCustomFieldDefs(data.subAccountId, "contact");
    const cf = validateCustomFieldValues(body.customFields, defs);
    if (!cf.ok) {
      return NextResponse.json({ error: cf.error }, { status: 400 });
    }
    patch.customFields = cf.value;
  }

  const result = await updateContactServerSide({
    contactId: id,
    patch,
    mode: (data as { mode?: "live" | "test" }).mode ?? "live",
  });
  if (!result) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }
  return NextResponse.json({ contact: result.contact });
}

/** Agency owner or sub-account admin. Returns a 403 response, or null if allowed. */
async function ensureContactAdmin(
  db: FirebaseFirestore.Firestore,
  caller: { uid: string; claims: CallerClaims },
  agencyId: string,
  subAccountId: string,
): Promise<NextResponse | null> {
  const isAgencyOwner =
    caller.claims.agencyRole === "owner" && caller.claims.agencyId === agencyId;
  if (isAgencyOwner) return null;

  const memberSnap = await db
    .doc(`subAccounts/${subAccountId}/subAccountMembers/${caller.uid}`)
    .get();
  const member = memberSnap.data();
  const isSubAccountAdmin =
    memberSnap.exists &&
    member?.status === "active" &&
    member?.role === "admin";
  if (isSubAccountAdmin) return null;

  return NextResponse.json(
    { error: "Only sub-account admins can delete contacts." },
    { status: 403 },
  );
}

/** Read-only deletability check for the confirm modal. */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const caller = await readCaller(request);
  if (caller instanceof NextResponse) return caller;

  const db = getAdminDb();
  const snap = await db.doc(`contacts/${id}`).get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }
  const { agencyId, subAccountId } = snap.data() as Omit<Contact, "id">;

  const denied = await ensureContactAdmin(db, caller, agencyId, subAccountId);
  if (denied) return denied;

  const { blockers } = await findContactBlockers(db, subAccountId, id);
  return NextResponse.json({ deletable: blockers.length === 0, blockers });
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const caller = await readCaller(request);
  if (caller instanceof NextResponse) return caller;

  const db = getAdminDb();
  const contactRef = db.doc(`contacts/${id}`);
  const snap = await contactRef.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }
  const contact = snap.data() as Omit<Contact, "id">;
  const { agencyId, subAccountId } = contact;

  const denied = await ensureContactAdmin(db, caller, agencyId, subAccountId);
  if (denied) return denied;

  // Linked business records never cascade; they must be cleared or reassigned first.
  const { blockers, submissionRefs } = await findContactBlockers(
    db,
    subAccountId,
    id,
  );
  if (blockers.length > 0) {
    return NextResponse.json(
      {
        error:
          "This contact is linked to other records and can't be deleted. Remove or reassign them first.",
        blockers,
      },
      { status: 409 },
    );
  }

  // Submissions cascade like notes. Blocking on them would make a spam contact
  // undeletable, since there's no per-submission delete anywhere.
  for (let i = 0; i < submissionRefs.length; i += 500) {
    const batch = db.batch();
    for (const ref of submissionRefs.slice(i, i + 500)) {
      batch.delete(ref);
    }
    await batch.commit();
  }

  const imported = await db
    .collection("events")
    .where("subAccountId", "==", subAccountId)
    .where("contactId", "==", id)
    .where("source", "==", "google")
    .get();
  for (let i = 0; i < imported.docs.length; i += 500) {
    const batch = db.batch();
    for (const d of imported.docs.slice(i, i + 500)) {
      batch.update(d.ref, { contactId: null });
    }
    await batch.commit();
  }

  await db.recursiveDelete(contactRef);

  // Doc is gone by the time subscribers react, so send the pre-delete snapshot.
  emitContactDeleted({ subAccountId, agencyId, contactId: id, data: contact });

  return NextResponse.json({ ok: true, contactId: id });
}

interface ContactBlocker {
  type: string;
  /** Singular label, e.g. "deal" -> "2 deals". */
  label: string;
  count: number;
}

/** Counts (via count() aggregation) every record a delete would orphan. */
async function findContactBlockers(
  db: FirebaseFirestore.Firestore,
  subAccountId: string,
  contactId: string,
): Promise<{
  blockers: ContactBlocker[];
  /** All the contact's form submissions. Swept by DELETE, never blocking. */
  submissionRefs: FirebaseFirestore.DocumentReference[];
}> {
  const inSub = (collection: string) =>
    db
      .collection(collection)
      .where("subAccountId", "==", subAccountId)
      .where("contactId", "==", contactId)
      .count()
      .get();

  const [
    deals,
    tasks,
    events,
    importedEvents,
    quotes,
    submissionDocs,
    webChats,
    voiceCalls,
  ] =
    await Promise.all([
      inSub("deals"),
      inSub("tasks"),
      inSub("events"),
      // Imported Google events only reference a contact for display; they
      // never block a delete and are unlinked when the contact goes.
      db
        .collection("events")
        .where("subAccountId", "==", subAccountId)
        .where("contactId", "==", contactId)
        .where("source", "==", "google")
        .count()
        .get(),
      inSub("quotes"),
      // Collection-group over forms/{id}/submissions. contactId is globally
      // unique so no sub-account filter is needed. Refs only.
      db
        .collectionGroup("submissions")
        .where("contactId", "==", contactId)
        .select()
        .limit(1000)
        .get(),
      db
        .collection("subAccounts")
        .doc(subAccountId)
        .collection("webChatSessions")
        .where("contactId", "==", contactId)
        .count()
        .get(),
      db
        .collection("subAccounts")
        .doc(subAccountId)
        .collection("voiceCalls")
        .where("contactId", "==", contactId)
        .count()
        .get(),
    ]);

  const out: ContactBlocker[] = [];
  const add = (count: number, type: string, label: string) => {
    if (count > 0) out.push({ type, label, count });
  };
  add(deals.data().count, "deals", "deal");
  add(tasks.data().count, "tasks", "task");
  add(
    events.data().count - importedEvents.data().count,
    "events",
    "calendar event / booking",
  );
  add(quotes.data().count, "quotes", "quote / invoice");
  add(webChats.data().count, "web_chat_sessions", "web-chat conversation");
  add(voiceCalls.data().count, "voice_calls", "voice call");
  return {
    blockers: out,
    submissionRefs: submissionDocs.docs.map((d) => d.ref),
  };
}
