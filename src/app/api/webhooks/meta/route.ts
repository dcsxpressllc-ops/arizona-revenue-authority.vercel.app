import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  getMetaUserName,
  metaWebhookVerifyToken,
  verifyMetaSignature,
} from "@/lib/comms/meta";
import { createContactServerSide } from "@/lib/server/contacts-service";
import { upsertConversationForMessage } from "@/lib/server/conversations-service";
import { resolveAgent } from "@/lib/comms/ai/agent";
import { maybeRespondWithAi } from "@/lib/comms/ai/respond";
import { aiChannelGateOn } from "@/lib/comms/ai/gates";
import { aiIsConfigured } from "@/lib/comms/ai/openrouter";
import { metaCanInstagramDm } from "@/lib/comms/meta-capabilities";
import type { ConversationChannel } from "@/types/conversations";
import type { SubAccountDoc } from "@/types";
import type { Contact } from "@/types/contacts";

export const dynamic = "force-dynamic";

/**
 * Meta inbound webhook (Messenger + Instagram DM, beta).
 * GET: verification handshake (echo hub.challenge). POST: message events.
 *
 * POST checks `X-Hub-Signature-256` (HMAC of the raw body with the app
 * secret) before anything else; public path, signature is the credential.
 * Like the WhatsApp route: resolve the sub-account from the receiving Page
 * or IG account, enforce `metaInboxEnabledByAgency`, reconcile the contact
 * by Meta user id, store to `contacts/{id}/metaMessages`, update the inbox
 * index. Always 200 so Meta doesn't retry-storm.
 *
 * After storing, the AI agent may auto-reply on the same platform. Needs
 * `aiChannelGateOn(sa, "meta")`, the `aiAgent/meta` doc enabled,
 * aiIsConfigured(), and for Instagram the `instagram_manage_messages`
 * scope. AI failures are logged and still return 200. Echoes and non-text
 * events are ignored.
 */

interface MetaMessaging {
  sender?: { id?: string };
  recipient?: { id?: string };
  message?: { mid?: string; text?: string; is_echo?: boolean };
}

interface MetaEntry {
  id?: string;
  messaging?: MetaMessaging[];
}

interface MetaWebhookBody {
  object?: string;
  entry?: MetaEntry[];
}

interface ResolvedRoute {
  subAccountId: string;
  agencyId: string;
  pageAccessToken: string;
  /** Whole doc, so AI dispatch has gates, metaConfig and bookingLink without
   *  a second read. */
  subAccount: SubAccountDoc;
}

/**
 * `object: "instagram"` routes by linked IG business-account id, anything
 * else by Page id. Null when nothing matches or the agency gate is off.
 */
async function resolveRoute(
  object: string,
  entryId: string,
): Promise<ResolvedRoute | null> {
  const field =
    object === "instagram"
      ? "metaConfig.instagramBusinessAccountId"
      : "metaConfig.pageId";

  const snap = await getAdminDb()
    .collection("subAccounts")
    .where(field, "==", entryId)
    .limit(1)
    .get();
  if (snap.empty) return null;

  const sa = snap.docs[0].data() as SubAccountDoc;
  if (sa.metaInboxEnabledByAgency !== true) {
    console.warn(
      `[webhooks/meta] event for ${entryId} (sa=${snap.docs[0].id}) but metaInboxEnabledByAgency is off — dropping`,
    );
    return null;
  }
  const token = sa.metaConfig?.pageAccessToken;
  if (!token) return null;

  return {
    subAccountId: snap.docs[0].id,
    agencyId: sa.agencyId,
    pageAccessToken: token,
    subAccount: sa,
  };
}

/**
 * AI auto-reply for one stored DM. All AI gates live here so storing never
 * depends on AI state. Errors are swallowed to keep the 200.
 */
async function maybeDispatchAiReply(input: {
  route: ResolvedRoute;
  contactId: string;
  channel: "messenger" | "instagram";
  senderId: string;
  text: string;
}): Promise<void> {
  const { route, contactId, channel, senderId, text } = input;
  const sa = route.subAccount;
  try {
    if (!aiIsConfigured()) return;
    // Separate from the inbox gate checked in resolveRoute. Manual inbox
    // replies are unaffected.
    if (!aiChannelGateOn(sa, "meta")) return;
    // Without the IG messaging scope we can't reply on Instagram; check before
    // spending LLM tokens. Messenger still works.
    if (channel === "instagram" && !metaCanInstagramDm(sa.metaConfig)) return;

    const agent = await resolveAgent(route.subAccountId, "meta");
    if (!agent?.effective.enabled) return;

    const contactSnap = await getAdminDb()
      .collection("contacts")
      .doc(contactId)
      .get();
    if (!contactSnap.exists) return;
    const contact: Contact = {
      id: contactSnap.id,
      ...(contactSnap.data() as Omit<Contact, "id">),
    };

    await maybeRespondWithAi({
      subAccountId: route.subAccountId,
      subAccount: sa,
      agent,
      channelId: "meta",
      metaChannel: channel,
      contact,
      incomingMessage: text,
      replyTo: senderId,
    });
  } catch (err) {
    console.error(
      `[webhooks/meta] AI reply pipeline failed sa=${route.subAccountId}`,
      err,
    );
  }
}

/**
 * Find or create the contact for this Meta user id (name fetched from Graph
 * best-effort). `seen` stops two events in one payload minting two contacts.
 */
async function reconcileContact(
  route: ResolvedRoute,
  senderId: string,
  channel: ConversationChannel,
  seen: Map<string, string>,
): Promise<{ id: string; name: string } | null> {
  const cached = seen.get(senderId);
  const db = getAdminDb();
  if (cached) {
    const snap = await db.collection("contacts").doc(cached).get();
    return { id: cached, name: (snap.data()?.name as string) ?? "" };
  }

  // Single-field equality + tenancy filter in code, so no composite index.
  const matches = await db
    .collection("contacts")
    .where("metaUserId", "==", senderId)
    .limit(5)
    .get();
  const existing = matches.docs.find(
    (d) => (d.data().subAccountId as string) === route.subAccountId,
  );
  if (existing) {
    seen.set(senderId, existing.id);
    return { id: existing.id, name: (existing.data().name as string) ?? "" };
  }

  const profileName = await getMetaUserName(senderId, route.pageAccessToken);
  try {
    const created = await createContactServerSide({
      subAccountId: route.subAccountId,
      agencyId: route.agencyId,
      createdByUid: "meta-inbound",
      mode: "live",
      name: profileName ?? "",
      email: "",
      phone: "",
      company: "",
      address: "",
      source: channel === "instagram" ? "instagram" : "facebook",
      tags: [],
    });
    // So later messages reconcile to this contact.
    await db
      .collection("contacts")
      .doc(created.id)
      .update({ metaUserId: senderId });
    seen.set(senderId, created.id);
    return { id: created.id, name: profileName ?? "" };
  } catch (err) {
    console.error(
      `[webhooks/meta] contact create failed sa=${route.subAccountId} sender=${senderId}`,
      err,
    );
    return null;
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  const verify = metaWebhookVerifyToken();
  if (mode === "subscribe" && verify && token === verify) {
    return new NextResponse(challenge ?? "", { status: 200 });
  }
  return new NextResponse("Forbidden", { status: 403 });
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");
  if (!verifyMetaSignature(rawBody, signature)) {
    return new NextResponse("Invalid signature", { status: 403 });
  }

  let payload: MetaWebhookBody;
  try {
    payload = JSON.parse(rawBody) as MetaWebhookBody;
  } catch {
    return NextResponse.json({ ok: true });
  }

  const object = payload.object ?? "page";
  // The AI dispatch needs this narrower union; it widens to
  // ConversationChannel where needed.
  const channel: "messenger" | "instagram" =
    object === "instagram" ? "instagram" : "messenger";
  const seen = new Map<string, string>();
  const db = getAdminDb();

  for (const entry of payload.entry ?? []) {
    const entryId = entry.id;
    if (!entryId) continue;

    let route: ResolvedRoute | null = null;
    for (const event of entry.messaging ?? []) {
      const senderId = event.sender?.id;
      const text = event.message?.text;
      // Text only. Skip echoes (our own sends), reactions, postbacks, read
      // receipts, and anything without a sender or body.
      if (!senderId || !text || event.message?.is_echo) continue;

      // Resolve once per entry, and only when there's real work.
      if (!route) {
        route = await resolveRoute(object, entryId);
        if (!route) break; // unknown page/IG id, or gate off
      }

      const contact = await reconcileContact(route, senderId, channel, seen);
      if (!contact) continue;

      const mid = event.message?.mid || db.collection("contacts").doc().id;
      try {
        await db
          .collection("contacts")
          .doc(contact.id)
          .collection("metaMessages")
          .doc(mid)
          .set(
            {
              agencyId: route.agencyId,
              subAccountId: route.subAccountId,
              contactId: contact.id,
              channel,
              direction: "inbound",
              status: "received",
              body: text,
              from: senderId,
              to: entryId,
              metaMessageId: event.message?.mid ?? null,
              error: null,
              readAt: null,
              createdAt: FieldValue.serverTimestamp(),
            },
            { merge: true }, // Meta retries with the same mid
          );
      } catch (err) {
        console.warn("[webhooks/meta] message-row write failed", err);
      }

      await upsertConversationForMessage({
        contactId: contact.id,
        subAccountId: route.subAccountId,
        agencyId: route.agencyId,
        contactName: contact.name,
        contactPhone: null,
        channel,
        direction: "inbound",
        body: text,
      });

      // Awaited (serverless can't fire-and-forget); errors are swallowed inside.
      // A Haiku reply (1-3s) fits well within Meta's timeout.
      await maybeDispatchAiReply({
        route,
        contactId: contact.id,
        channel,
        senderId,
        text,
      });
    }
  }

  return NextResponse.json({ ok: true });
}
