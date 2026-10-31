import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import type { DocumentSnapshot } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  bareEmailAddress,
  capInboundText,
  emailInboxEnabled,
  fetchReceivedEmail,
  looksLikeAutoMail,
  parseCaptureAddress,
  sanitizeInboundHtml,
  verifyResendWebhook,
} from "@/lib/comms/email-inbox";
import {
  handleResendDeliveryEvent,
  isTrackedEmailEvent,
  type ResendDeliveryEvent,
} from "@/lib/comms/email-events";
import { resolveAgent } from "@/lib/comms/ai/agent";
import { aiIsConfigured } from "@/lib/comms/ai/openrouter";
import { maybeRespondWithAi } from "@/lib/comms/ai/respond";
import { createContactServerSide } from "@/lib/server/contacts-service";
import { upsertConversationForMessage } from "@/lib/server/conversations-service";
import type { Contact } from "@/types/contacts";
import type { SubAccountDoc } from "@/types";

export const dynamic = "force-dynamic";

/**
 * Resend webhook endpoint, shared by the two-way email inbox
 * (`email.received`) and broadcast engagement stats (`email.delivered`,
 * `opened`, `clicked`, `bounced`, `complained`, handed to
 * lib/comms/email-events.ts). One Resend account per deployment, so one
 * endpoint for every sub-account; inbound mail is routed by the capture
 * address's domain -> `resendConfig.domainName`.
 *
 * Verifies the Svix signature (503 without RESEND_WEBHOOK_SECRET, which the
 * settings toggle surfaces) and ignores other event types. The webhook is
 * metadata only, so the full email is fetched from Resend. Finds the capture
 * address, resolves the sub-account and re-checks the agency gate and inbox
 * opt-in, and drops bounces/auto-replies. Contact: plus-addressed id first,
 * then sender email, else auto-create (`source: "email"`) like WhatsApp.
 * Writes `contacts/{id}/emailMessages/{emailId}` (Resend id, so retries
 * dedupe) and upserts the inbox row, which also fires message.received,
 * push, the workflow trigger and wait_for_reply.
 *
 * Always 200 except a bad signature.
 */

interface ReceivedEventBody {
  type?: string;
  data?: { email_id?: string; to?: unknown };
}

const ok = () => NextResponse.json({ ok: true });

export async function POST(request: Request) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "RESEND_WEBHOOK_SECRET is not configured on this deployment." },
      { status: 503 },
    );
  }

  const rawBody = await request.text();
  const verified = verifyResendWebhook({
    id: request.headers.get("svix-id"),
    timestamp: request.headers.get("svix-timestamp"),
    signature: request.headers.get("svix-signature"),
    rawBody,
    secret,
  });
  if (!verified) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let event: ReceivedEventBody;
  try {
    event = JSON.parse(rawBody) as ReceivedEventBody;
  } catch {
    return ok();
  }
  // Delivery/open/click/bounce/complaint events share this endpoint and
  // secret; they resolve to a broadcast send row and never touch the inbox.
  if (isTrackedEmailEvent(event.type)) {
    await handleResendDeliveryEvent(event as ResendDeliveryEvent);
    return ok();
  }
  if (event.type !== "email.received" || !event.data?.email_id) return ok();

  const email = await fetchReceivedEmail(String(event.data.email_id));
  if (!email) return ok();

  // Check the event's `to` too, in case the fetched record drops a forwarded
  // recipient. A plus-tagged address (`replies+<contactId>@`) threads exactly
  // and is preferred, but any address on the tenant's receiving domain is
  // accepted: some mail clients ignore Reply-To and answer the From mailbox
  // (e.g. hello@). Those thread by sender email.
  const recipients = [
    ...email.to,
    ...(Array.isArray(event.data.to) ? event.data.to.map(String) : []),
  ];
  const candidates: { domain: string; contactId: string | null }[] = [];
  for (const r of recipients) {
    // Passed raw: the plus-tag is a case-sensitive doc id.
    const parsed = parseCaptureAddress(r);
    if (parsed) candidates.push(parsed);
  }
  for (const r of recipients) {
    const addr = bareEmailAddress(r);
    const at = addr.lastIndexOf("@");
    if (at > 0) candidates.push({ domain: addr.slice(at + 1), contactId: null });
  }
  if (candidates.length === 0) return ok();

  const db = getAdminDb();
  let capture: { domain: string; contactId: string | null } | null = null;
  let subSnap: FirebaseFirestore.QueryDocumentSnapshot | null = null;
  const seenDomains = new Set<string>();
  for (const candidate of candidates) {
    // Plus-tagged candidates may repeat a domain (different contactId);
    // untagged duplicates are skipped.
    const dedupeKey = `${candidate.domain}|${candidate.contactId ?? ""}`;
    if (seenDomains.has(dedupeKey)) continue;
    seenDomains.add(dedupeKey);
    const matches = await db
      .collection("subAccounts")
      .where("resendConfig.domainName", "==", candidate.domain)
      .limit(2)
      .get();
    if (!matches.empty) {
      capture = candidate;
      subSnap = matches.docs[0];
      break;
    }
  }
  if (!capture || !subSnap) return ok();
  const sub = subSnap.data() as SubAccountDoc;
  if (!emailInboxEnabled(sub)) {
    console.warn(
      `[resend/inbound] dropped mail for ${capture.domain} — inbox not enabled (sa=${subSnap.id})`,
    );
    return ok();
  }
  const subAccountId = subSnap.id;
  const agencyId = (sub as { agencyId?: string }).agencyId ?? "";

  if (
    looksLikeAutoMail({
      from: email.from,
      subject: email.subject,
      headers: email.headers,
    })
  ) {
    return ok();
  }

  const fromAddress = bareEmailAddress(email.from);
  if (!fromAddress) return ok();

  // Plus-address wins, then sender email, then create.
  let contactDocs: DocumentSnapshot[] = [];
  if (capture.contactId) {
    const snap = await db.collection("contacts").doc(capture.contactId).get();
    const data = snap.data() as { subAccountId?: string } | undefined;
    if (snap.exists && data?.subAccountId === subAccountId) {
      contactDocs = [snap];
    }
  }
  if (contactDocs.length === 0) {
    const matches = await db
      .collection("contacts")
      .where("email", "==", fromAddress)
      .where("subAccountId", "==", subAccountId)
      .limit(5)
      .get();
    contactDocs = matches.docs;
  }
  if (contactDocs.length === 0) {
    // "Jane Doe <jane@x.com>" -> "Jane Doe".
    const displayName = email.from.replace(/<[^>]*>/, "").replace(/["']/g, "").trim();
    try {
      const created = await createContactServerSide({
        subAccountId,
        agencyId,
        createdByUid: "resend-email-inbound",
        mode: "live",
        name: displayName,
        email: fromAddress,
        phone: "",
        company: "",
        address: "",
        source: "email",
        tags: [],
      });
      contactDocs = [await db.collection("contacts").doc(created.id).get()];
    } catch (err) {
      console.error(
        `[resend/inbound] failed to auto-create contact for ${fromAddress} (sa=${subAccountId})`,
        err,
      );
      return ok();
    }
  }

  const bodyText = capInboundText(email.text);
  const bodyHtml = sanitizeInboundHtml(email.html);
  const subject = email.subject.trim().slice(0, 300);
  const preview = bodyText || subject || "(no content)";

  const writes = contactDocs.map((d) =>
    d.ref
      .collection("emailMessages")
      .doc(email.id)
      .set(
        {
          agencyId,
          subAccountId,
          contactId: d.id,
          direction: "inbound",
          status: "received",
          subject,
          body: bodyText,
          bodyHtml,
          from: fromAddress,
          to: recipients[0] ? bareEmailAddress(recipients[0]) : "",
          resendEmailId: email.id,
          messageId: email.messageId,
          sentByUid: null,
          error: null,
          readAt: null,
          createdAt: FieldValue.serverTimestamp(),
        },
        { merge: true }, // Resend retries with the same email id
      ),
  );
  try {
    await Promise.all(writes);
  } catch (err) {
    console.warn("[resend/inbound] message-row write failed", err);
  }

  await Promise.all(
    contactDocs.map((d) => {
      const cdata = d.data() as { name?: string; phone?: string } | undefined;
      return upsertConversationForMessage({
        contactId: d.id,
        subAccountId,
        agencyId,
        contactName: cdata?.name ?? "",
        contactPhone: cdata?.phone ?? null,
        channel: "email",
        direction: "inbound",
        body: preview,
      });
    }),
  );

  // Email AI is suggest-only: the orchestrator forces draft mode, so this
  // stores a pendingDraft for a human to approve and never sends. Same
  // dispatch as the WhatsApp webhook.
  if (contactDocs.length > 0 && aiIsConfigured()) {
    try {
      const agent = await resolveAgent(subAccountId, "email");
      if (agent?.effective.enabled) {
        const contactDoc = contactDocs[0];
        const contact = {
          id: contactDoc.id,
          ...(contactDoc.data() as Omit<Contact, "id">),
        };
        await maybeRespondWithAi({
          subAccountId,
          subAccount: sub,
          agent,
          channelId: "email",
          contact,
          incomingMessage: bodyText || subject || "(no content)",
          replyTo: fromAddress,
        });
      }
    } catch (err) {
      console.error(
        `[resend/inbound] AI draft pipeline failed for sa=${subAccountId}`,
        err,
      );
    }
  }

  return ok();
}
