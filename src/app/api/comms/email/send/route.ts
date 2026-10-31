import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { emailIsConfigured, sendEmail, tenantFrom } from "@/lib/comms/resend";
import {
  emailInboxEnabled,
  resolveThreadedReplyTo,
} from "@/lib/comms/email-inbox";
import { requireContactAccessible, requireUid } from "@/lib/comms/route-auth";
import { upsertConversationForMessage } from "@/lib/server/conversations-service";
import { checkQuota } from "@/lib/server/usage-meter";
import { recordSend } from "@/lib/comms/usage";
import type { SubAccountDoc } from "@/types";

type Body = { contactId?: string; subject?: string; body?: string; approvedDraft?: boolean };

// Subject for inbox-composer sends with none given: "Re:" the latest inbound
// subject, else a generic one.
async function deriveSubject(
  contactId: string,
  subAccountName: string | undefined,
): Promise<string> {
  try {
    // Single-field orderBy + in-memory direction filter avoids a composite
    // index on the subcollection.
    const recent = await getAdminDb()
      .collection("contacts")
      .doc(contactId)
      .collection("emailMessages")
      .orderBy("createdAt", "desc")
      .limit(10)
      .get();
    const lastInbound = recent.docs.find(
      (d) => d.data()?.direction === "inbound",
    );
    const subject = (lastInbound?.data()?.subject as string | undefined)?.trim();
    if (subject) {
      return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
    }
  } catch (err) {
    console.warn("[email/send] subject derivation failed", err);
  }
  return subAccountName ? `Message from ${subAccountName}` : "Message";
}

export async function POST(request: Request) {
  if (!emailIsConfigured()) {
    return NextResponse.json(
      { error: "Email is not configured on this deployment." },
      { status: 503 },
    );
  }

  const auth = requireUid(request);
  if (auth instanceof NextResponse) return auth;

  let payload: Body;
  try {
    payload = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const contactId = payload.contactId?.trim();
  let subject = payload.subject?.trim();
  const body = payload.body?.trim();

  if (!contactId || !body) {
    return NextResponse.json(
      { error: "contactId and body are required" },
      { status: 400 },
    );
  }

  const contact = await requireContactAccessible(auth.uid, contactId);
  if (contact instanceof NextResponse) return contact;

  if (!contact.email) {
    return NextResponse.json(
      { error: "This contact has no email address." },
      { status: 400 },
    );
  }

  // Reply-To prefers the sub-account's nominated address so every reply for
  // this client lands in one inbox, whoever sent; falls back to the sender.
  const subAccountSnap = await getAdminDb()
    .doc(`subAccounts/${contact.subAccountId}`)
    .get();
  const subAccount = subAccountSnap.data() as SubAccountDoc | undefined;
  // With the inbox on, replies go to the per-contact plus-addressed capture
  // address so they thread back into the unified inbox.
  const inboxOn = emailInboxEnabled(subAccount);
  const replyTo = resolveThreadedReplyTo(
    subAccount,
    contactId,
    subAccount?.replyToEmail ?? auth.email ?? undefined,
  );

  // Inbox-composer sends may omit the subject; derive a threaded "Re: ...".
  if (!subject) {
    if (!inboxOn) {
      return NextResponse.json(
        { error: "subject is required" },
        { status: 400 },
      );
    }
    subject = await deriveSubject(contactId, subAccount?.name);
  }

  // Monthly email quota. Fails open.
  const quota = await checkQuota({
    subAccountId: contact.subAccountId,
    unit: "emailsSent",
    subAccount,
  });
  if (!quota.allowed && quota.error) {
    return NextResponse.json({ error: quota.error.message }, { status: 429 });
  }

  let messageId: string;
  try {
    const result = await sendEmail({
      to: contact.email,
      subject,
      text: body,
      replyTo,
      from: tenantFrom(subAccount),
      meter: { subAccountId: contact.subAccountId },
    });
    messageId = result.id;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to send email";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  try {
    await getAdminDb()
      .collection("contacts")
      .doc(contactId)
      .collection("activities")
      .add({
        type: "email_sent",
        content: `Email: ${subject}`,
        createdBy: auth.uid,
        meta: { messageId, subject },
        createdAt: FieldValue.serverTimestamp(),
      });
  } catch (err) {
    console.warn("[email/send] activity write failed", err);
  }

  // Thread the outbound send. Best-effort: never fail a send that already
  // went out.
  if (inboxOn) {
    try {
      await getAdminDb()
        .collection("contacts")
        .doc(contactId)
        .collection("emailMessages")
        .add({
          agencyId: contact.agencyId ?? "",
          subAccountId: contact.subAccountId,
          contactId,
          direction: "outbound",
          status: "sent",
          subject,
          body,
          bodyHtml: null,
          from: tenantFrom(subAccount) ?? "",
          to: contact.email,
          resendEmailId: messageId,
          messageId: null,
          sentByUid: auth.uid,
          error: null,
          readAt: null,
          createdAt: FieldValue.serverTimestamp(),
        });
      await upsertConversationForMessage({
        contactId,
        subAccountId: contact.subAccountId,
        agencyId: contact.agencyId ?? "",
        contactName: contact.name ?? "",
        contactPhone: contact.phone ?? null,
        channel: "email",
        direction: "outbound",
        body: body,
        pauseBot: true,
        // The inbox draft card sets this; it bills the AI reply once actually sent.
        approvedDraft: payload.approvedDraft === true,
      });
    } catch (err) {
      console.warn("[email/send] thread row write failed", err);
    }
  }

  await recordSend(auth.uid, "email");

  return NextResponse.json({ ok: true, id: messageId });
}
