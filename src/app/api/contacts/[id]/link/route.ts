import "server-only";

import { NextResponse } from "next/server";
import { FieldValue, type Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { emitContactDeleted } from "@/lib/server/contacts-service";
import type { Contact } from "@/types/contacts";

/**
 * POST { targetContactId }: merge a Messenger/IG stub contact (PSID only) into
 * an existing contact. [id] is the stub, the target survives.
 *
 * Admin only. The stub must have a `metaUserId` so this can't be used as a
 * general merge, the target must be in the same sub-account and not linked to
 * a different Meta identity (409). Messages, references and the inbox index
 * move to the survivor, then the stub is deleted. Not reversible.
 */

const SUBCOLLECTIONS = [
  "metaMessages",
  "messages",
  "whatsappMessages",
  "notes",
  "activities",
] as const;

function tsMillis(v: unknown): number {
  const d = (v as { toMillis?: () => number } | null)?.toMillis?.();
  return typeof d === "number" ? d : 0;
}

async function repoint(
  db: FirebaseFirestore.Firestore,
  snap: FirebaseFirestore.QuerySnapshot,
  targetId: string,
): Promise<void> {
  let batch = db.batch();
  let n = 0;
  for (const d of snap.docs) {
    batch.update(d.ref, { contactId: targetId });
    if (++n % 400 === 0) {
      await batch.commit();
      batch = db.batch();
    }
  }
  if (n % 400 !== 0) await batch.commit();
}

/** Copies a stub subcollection onto the survivor, keeping doc ids. */
async function copySubcollection(
  db: FirebaseFirestore.Firestore,
  stubRef: FirebaseFirestore.DocumentReference,
  targetRef: FirebaseFirestore.DocumentReference,
  name: string,
  targetId: string,
): Promise<void> {
  const docs = await stubRef.collection(name).get();
  let batch = db.batch();
  let n = 0;
  for (const d of docs.docs) {
    const data = d.data();
    if ("contactId" in data) data.contactId = targetId;
    batch.set(targetRef.collection(name).doc(d.id), data, { merge: true });
    if (++n % 400 === 0) {
      await batch.commit();
      batch = db.batch();
    }
  }
  if (n % 400 !== 0) await batch.commit();
}

async function mergeConversation(
  db: FirebaseFirestore.Firestore,
  stubId: string,
  targetId: string,
  target: Pick<Contact, "name" | "phone">,
): Promise<void> {
  const stubConvRef = db.doc(`conversations/${stubId}`);
  const targetConvRef = db.doc(`conversations/${targetId}`);
  const [s, t] = await Promise.all([stubConvRef.get(), targetConvRef.get()]);
  if (!s.exists) return; // no stub conversation to merge
  const sc = s.data() ?? {};

  if (!t.exists) {
    // Survivor had none: adopt the stub's, re-keyed.
    await targetConvRef.set({
      ...sc,
      contactId: targetId,
      contactName: target.name ?? (sc.contactName as string) ?? "",
      contactPhone: target.phone || (sc.contactPhone as string) || null,
      updatedAt: FieldValue.serverTimestamp(),
    });
  } else {
    const tc = t.data() ?? {};
    const channelsSeen = Array.from(
      new Set([
        ...((tc.channelsSeen as string[]) ?? []),
        ...((sc.channelsSeen as string[]) ?? []),
      ]),
    );
    const patch: Record<string, unknown> = {
      channelsSeen,
      unreadCount:
        ((tc.unreadCount as number) ?? 0) + ((sc.unreadCount as number) ?? 0),
      updatedAt: FieldValue.serverTimestamp(),
    };
    // Take the stub's "last message" fields only if newer.
    if (tsMillis(sc.lastMessageAt) > tsMillis(tc.lastMessageAt)) {
      patch.lastChannel = sc.lastChannel;
      patch.lastDirection = sc.lastDirection;
      patch.lastMessagePreview = sc.lastMessagePreview;
      patch.lastMessageAt = sc.lastMessageAt as Timestamp;
    }
    await targetConvRef.set(patch, { merge: true });
  }
  await stubConvRef.delete().catch(() => {});
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: stubId } = await ctx.params;

  let body: { targetContactId?: string };
  try {
    body = (await request.json()) as { targetContactId?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const targetId = body.targetContactId?.trim();
  if (!targetId) {
    return NextResponse.json(
      { error: "targetContactId is required" },
      { status: 400 },
    );
  }
  if (targetId === stubId) {
    return NextResponse.json(
      { error: "Can't link a contact to itself." },
      { status: 400 },
    );
  }

  const db = getAdminDb();
  const stubRef = db.doc(`contacts/${stubId}`);
  const targetRef = db.doc(`contacts/${targetId}`);
  const [stubSnap, targetSnap] = await Promise.all([
    stubRef.get(),
    targetRef.get(),
  ]);
  if (!stubSnap.exists) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }
  const stub = stubSnap.data() as Omit<Contact, "id">;

  const access = await requireSubAccountAdmin(request, stub.subAccountId);
  if (access instanceof NextResponse) return access;

  // Meta stubs only, never a general merge tool.
  if (!stub.metaUserId) {
    return NextResponse.json(
      {
        error:
          "Only Facebook/Instagram contacts can be linked this way.",
      },
      { status: 400 },
    );
  }

  if (!targetSnap.exists) {
    return NextResponse.json(
      { error: "The contact to merge into wasn't found." },
      { status: 404 },
    );
  }
  const target = targetSnap.data() as Omit<Contact, "id">;
  if (target.subAccountId !== stub.subAccountId) {
    return NextResponse.json(
      { error: "Both contacts must be in the same sub-account." },
      { status: 400 },
    );
  }
  if (target.metaUserId && target.metaUserId !== stub.metaUserId) {
    return NextResponse.json(
      {
        error:
          "That contact is already linked to a different Facebook/Instagram identity.",
      },
      { status: 409 },
    );
  }

  const sub = stub.subAccountId;

  for (const name of SUBCOLLECTIONS) {
    await copySubcollection(db, stubRef, targetRef, name, targetId);
  }

  // Re-point everything in the contact-delete blocker set so nothing orphans.
  const [deals, tasks, events, quotes, submissions, webChats, voiceCalls] =
    await Promise.all([
      db.collection("deals").where("subAccountId", "==", sub).where("contactId", "==", stubId).get(),
      db.collection("tasks").where("subAccountId", "==", sub).where("contactId", "==", stubId).get(),
      db.collection("events").where("subAccountId", "==", sub).where("contactId", "==", stubId).get(),
      db.collection("quotes").where("subAccountId", "==", sub).where("contactId", "==", stubId).get(),
      db.collectionGroup("submissions").where("contactId", "==", stubId).get(),
      db.collection("subAccounts").doc(sub).collection("webChatSessions").where("contactId", "==", stubId).get(),
      db.collection("subAccounts").doc(sub).collection("voiceCalls").where("contactId", "==", stubId).get(),
    ]);
  for (const snap of [deals, tasks, events, quotes, submissions, webChats, voiceCalls]) {
    await repoint(db, snap, targetId);
  }

  await mergeConversation(db, stubId, targetId, {
    name: target.name,
    phone: target.phone,
  });

  await targetRef.update({
    metaUserId: stub.metaUserId,
    updatedAt: FieldValue.serverTimestamp(),
  });

  // Delete the stub; contact.deleted fires from the pre-delete snapshot.
  await db.recursiveDelete(stubRef);
  emitContactDeleted({
    subAccountId: sub,
    agencyId: stub.agencyId,
    contactId: stubId,
    data: stub,
  });

  return NextResponse.json({ ok: true, targetContactId: targetId });
}
