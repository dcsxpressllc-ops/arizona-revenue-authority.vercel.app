import "server-only";

import { NextResponse } from "next/server";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { qstashIsConfigured, verifyQStashSignature } from "@/lib/automations/qstash";
import { sendEmail, emailIsConfigured, tenantFrom } from "@/lib/comms/resend";
import { resolveThreadedReplyTo } from "@/lib/comms/email-inbox";
import { checkQuota } from "@/lib/server/usage-meter";
import { resolveMergeTags } from "@/lib/automations/merge-tags";
import { buildUnsubscribeUrl } from "@/lib/automations/unsubscribe-token";
import type {
  AgencyDoc,
  BroadcastDoc,
  BroadcastSendDoc,
  MessageTemplateDoc,
  SubAccountDoc,
} from "@/types";
import type { Contact } from "@/types/contacts";

export const dynamic = "force-dynamic";

interface StepBody {
  broadcastId?: string;
  contactId?: string;
}

/**
 * QStash callback that sends one broadcast recipient's email. Public path;
 * the Upstash signature is the auth. Settled rows are skipped, opt-out is
 * re-checked live, and the last settled row completes the broadcast.
 * Send failures are recorded as `failed` with a 200 so one bounce can't
 * retry-storm the whole audience.
 */
export async function POST(request: Request) {
  if (!qstashIsConfigured()) {
    return NextResponse.json(
      { error: "QStash is not configured on this deployment." },
      { status: 503 },
    );
  }
  if (!emailIsConfigured()) {
    // Resend creds gone since fan-out. 503 so QStash retries and the batch
    // survives until keys are restored (unlike a per-recipient failure).
    return NextResponse.json(
      { error: "Email is not configured." },
      { status: 503 },
    );
  }

  const signature = request.headers.get("upstash-signature");
  if (!signature) {
    return NextResponse.json(
      { error: "Missing Upstash-Signature header" },
      { status: 401 },
    );
  }
  const rawBody = await request.text();
  const valid = await verifyQStashSignature(signature, rawBody);
  if (!valid) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: StepBody;
  try {
    payload = JSON.parse(rawBody) as StepBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const broadcastId = payload.broadcastId;
  const contactId = payload.contactId;
  if (typeof broadcastId !== "string" || typeof contactId !== "string") {
    return NextResponse.json(
      { error: "Body must include broadcastId (string) and contactId (string)" },
      { status: 400 },
    );
  }

  const db = getAdminDb();
  const broadcastRef = db.collection("broadcasts").doc(broadcastId);
  const sendRef = broadcastRef.collection("sends").doc(contactId);

  const [broadcastSnap, sendSnap] = await Promise.all([
    broadcastRef.get(),
    sendRef.get(),
  ]);
  if (!broadcastSnap.exists || !sendSnap.exists) {
    // Deleted since scheduling; a retry won't help.
    return NextResponse.json({ ok: true, ignored: "missing" });
  }
  const broadcast = broadcastSnap.data() as BroadcastDoc;
  const send = sendSnap.data() as BroadcastSendDoc;

  // A settled row is never re-sent (covers QStash retries and reruns).
  if (send.status !== "queued") {
    return NextResponse.json({ ok: true, ignored: "already_settled" });
  }

  const contactRef = db.collection("contacts").doc(contactId);
  const [contactSnap, templateSnap, subAccountSnap, agencySnap] =
    await Promise.all([
      contactRef.get(),
      db.collection("message_templates").doc(broadcast.templateId).get(),
      db.collection("subAccounts").doc(broadcast.subAccountId).get(),
      db.collection("agencies").doc(broadcast.agencyId).get(),
    ]);

  if (!contactSnap.exists) {
    await markSkipped(sendRef, broadcastRef, "contact_missing");
    await maybeMarkBroadcastCompleted(broadcastRef);
    return NextResponse.json({ ok: true, status: "skipped" });
  }
  const contact = {
    id: contactSnap.id,
    ...(contactSnap.data() as Omit<Contact, "id">),
  };

  // Live opt-out re-check catches anyone who unsubscribed mid-batch.
  if (contact.emailOptedOut) {
    await markSkipped(sendRef, broadcastRef, "opt_out");
    await maybeMarkBroadcastCompleted(broadcastRef);
    return NextResponse.json({ ok: true, status: "skipped" });
  }
  if (!contact.email) {
    await markSkipped(sendRef, broadcastRef, "no_email");
    await maybeMarkBroadcastCompleted(broadcastRef);
    return NextResponse.json({ ok: true, status: "skipped" });
  }

  if (!templateSnap.exists) {
    await markFailed(
      sendRef,
      broadcastRef,
      `Template ${broadcast.templateId} not found`,
    );
    await maybeMarkBroadcastCompleted(broadcastRef);
    return NextResponse.json({ ok: true, status: "failed" });
  }
  const template = templateSnap.data() as MessageTemplateDoc;
  const subAccount = subAccountSnap.exists
    ? (subAccountSnap.data() as SubAccountDoc)
    : null;
  const agency = agencySnap.exists ? (agencySnap.data() as AgencyDoc) : null;

  // Owner snapshot for merge tags.
  let ownerDisplayName = "";
  let ownerEmail = "";
  if (agency?.ownerUid) {
    try {
      const ownerSnap = await db.collection("users").doc(agency.ownerUid).get();
      const data = ownerSnap.data();
      ownerDisplayName = (data?.displayName as string) ?? "";
      ownerEmail = (data?.email as string) ?? "";
    } catch {
    }
  }

  const unsubscribeLink = buildUnsubscribeUrl(contact.id);
  const baseSubject = {
    contact: {
      name: contact.name,
      email: contact.email,
      phone: contact.phone,
    },
    owner: { displayName: ownerDisplayName, email: ownerEmail },
    workspace: { name: subAccount?.name ?? "" },
    bookingLink: subAccount?.bookingLink ?? "",
  } as const;

  const text = resolveMergeTags(template.body, {
    ...baseSubject,
    unsubscribeLink,
  });
  const subject = resolveMergeTags(template.subject ?? "", {
    ...baseSubject,
    unsubscribeLink,
  });

  // Same HTML render as the workflow executor. Template content isn't
  // escaped because templates are admin-authored.
  const htmlAnchor = unsubscribeLink
    ? `<a href="${unsubscribeLink}">Unsubscribe</a>`
    : "";
  const htmlInner = resolveMergeTags(template.body, {
    ...baseSubject,
    unsubscribeLink: htmlAnchor,
  }).replace(/\r?\n/g, "<br>");
  const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,sans-serif;line-height:1.6;color:#1a1a1a;max-width:600px;margin:0 auto;padding:24px;">${htmlInner}</body></html>`;

  // Monthly email quota: over-cap rows are recorded as failed with a reason.
  // Fails open.
  const quota = await checkQuota({
    subAccountId: broadcast.subAccountId,
    unit: "emailsSent",
    subAccount,
  });
  if (!quota.allowed && quota.error) {
    await markFailed(sendRef, broadcastRef, quota.error.message);
    await maybeMarkBroadcastCompleted(broadcastRef);
    return NextResponse.json({ ok: true, status: "failed" });
  }

  let resendMessageId: string | null = null;
  let error: string | null = null;
  try {
    const result = await sendEmail({
      to: contact.email,
      subject: subject || "(no subject)",
      text,
      html,
      // With the email inbox on, replies are plus-addressed into the unified
      // inbox; otherwise they go to replyToEmail.
      replyTo: resolveThreadedReplyTo(
        subAccount,
        contact.id,
        subAccount?.replyToEmail ?? undefined,
      ),
      from: tenantFrom(subAccount),
      meter: { subAccountId: broadcast.subAccountId },
    });
    resendMessageId = result.id;
  } catch (err) {
    error = err instanceof Error ? err.message : "Send failed";
  }

  if (resendMessageId) {
    await sendRef.update({
      status: "sent",
      resendMessageId,
      sentAt: FieldValue.serverTimestamp(),
      attempts: FieldValue.increment(1),
    });
    await broadcastRef.update({
      "totals.sent": FieldValue.increment(1),
      "totals.queued": FieldValue.increment(-1),
      // queued -> sending on the first settled row; completion is handled
      // by maybeMarkBroadcastCompleted.
      ...(broadcast.status === "queued" ? { status: "sending", startedAt: FieldValue.serverTimestamp() } : {}),
    });
    // Same activity shape as a manual send.
    await contactRef
      .collection("activities")
      .add({
        type: "email_sent",
        content: `Bulk email: ${broadcast.templateName}`,
        createdBy: "broadcast",
        meta: {
          broadcastId,
          messageId: resendMessageId,
          subject,
        },
        createdAt: FieldValue.serverTimestamp(),
      })
      .catch((err) =>
        console.warn("[broadcasts/step] activity write failed", err),
      );
  } else {
    await sendRef.update({
      status: "failed",
      error: error ?? "unknown",
      sentAt: Timestamp.now(),
      attempts: FieldValue.increment(1),
    });
    await broadcastRef.update({
      "totals.failed": FieldValue.increment(1),
      "totals.queued": FieldValue.increment(-1),
      ...(broadcast.status === "queued" ? { status: "sending", startedAt: FieldValue.serverTimestamp() } : {}),
    });
  }

  await maybeMarkBroadcastCompleted(broadcastRef);

  return NextResponse.json({ ok: true });
}

async function markSkipped(
  sendRef: FirebaseFirestore.DocumentReference,
  broadcastRef: FirebaseFirestore.DocumentReference,
  reason: "opt_out" | "no_email" | "contact_missing",
): Promise<void> {
  await sendRef.update({
    status: "skipped",
    skippedReason: reason,
    sentAt: FieldValue.serverTimestamp(),
    attempts: FieldValue.increment(1),
  });
  await broadcastRef.update({
    "totals.skipped": FieldValue.increment(1),
    "totals.queued": FieldValue.increment(-1),
  });
}

async function markFailed(
  sendRef: FirebaseFirestore.DocumentReference,
  broadcastRef: FirebaseFirestore.DocumentReference,
  errorMessage: string,
): Promise<void> {
  await sendRef.update({
    status: "failed",
    error: errorMessage,
    sentAt: FieldValue.serverTimestamp(),
    attempts: FieldValue.increment(1),
  });
  await broadcastRef.update({
    "totals.failed": FieldValue.increment(1),
    "totals.queued": FieldValue.increment(-1),
  });
}

/**
 * Marks the broadcast completed once totals.queued hits 0. Transactional so
 * two rows settling at once can't flip it twice.
 */
async function maybeMarkBroadcastCompleted(
  broadcastRef: FirebaseFirestore.DocumentReference,
): Promise<void> {
  await getAdminDb().runTransaction(async (tx) => {
    const snap = await tx.get(broadcastRef);
    if (!snap.exists) return;
    const data = snap.data() as BroadcastDoc;
    if (data.status === "completed" || data.status === "failed") return;
    if ((data.totals?.queued ?? 0) <= 0) {
      tx.update(broadcastRef, {
        status: "completed",
        completedAt: FieldValue.serverTimestamp(),
      });
    }
  });
}
