import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import type { DocumentSnapshot } from "firebase-admin/firestore";
import twilio from "twilio";
import { getAdminDb } from "@/lib/firebase/admin";
import { resolveAgent } from "@/lib/comms/ai/agent";
import { maybeRespondWithAi } from "@/lib/comms/ai/respond";
import { aiIsConfigured } from "@/lib/comms/ai/openrouter";
import { stripWhatsappPrefix } from "@/lib/comms/twilio";
import { createContactServerSide } from "@/lib/server/contacts-service";
import { upsertConversationForMessage } from "@/lib/server/conversations-service";
import type { SubAccountDoc } from "@/types";
import type { Contact } from "@/types/contacts";

export const dynamic = "force-dynamic";

/**
 * Twilio inbound WhatsApp webhook. Dedicated-only (no shared fallback like
 * SMS): every sender belongs to one sub-account.
 *
 * Twilio prefixes From/To with `whatsapp:`; we strip it for routing and
 * storage but validate the signature over the raw params. Routes by
 * `twilioConfig.whatsappFromNumber`, requires `whatsappEnabledByAgency`,
 * then checks the signature with the sub-account's authToken.
 *
 * Unknown senders are auto-created (phone, WhatsApp ProfileName,
 * `source: "whatsapp"`) so "Contact us on WhatsApp" captures new leads,
 * except when a never-seen number's first message is STOP/START. STOP/START
 * flips `whatsappOptedOut`; other messages go to
 * `contacts/{id}/whatsappMessages/{sid}` and may get an AI reply.
 * Always 200 + empty TwiML.
 */

const STOP_WORDS = new Set([
  "STOP",
  "STOPALL",
  "UNSUBSCRIBE",
  "CANCEL",
  "END",
  "QUIT",
]);
const START_WORDS = new Set(["START", "UNSTOP", "YES"]);

function emptyTwimlResponse(): string {
  return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
}

function twimlResponse(body: string): NextResponse {
  return new NextResponse(body, {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}

function normalisePhone(s: string): string {
  let cleaned = s.trim().replace(/[\s\-()]/g, "");
  if (cleaned.startsWith("00")) cleaned = "+" + cleaned.slice(2);
  return cleaned;
}

interface ResolvedRoute {
  authToken: string;
  subAccountId: string;
  agencyId: string | null;
}

/** Null when no sender matches or the agency gate is off; caller drops. */
async function resolveRoute(toNumber: string): Promise<ResolvedRoute | null> {
  if (!toNumber) return null;
  const normalisedTo = normalisePhone(toNumber);

  const snap = await getAdminDb()
    .collection("subAccounts")
    .where("twilioConfig.whatsappFromNumber", "==", normalisedTo)
    .where("twilioConfig.enabled", "==", true)
    .limit(1)
    .get();
  if (snap.empty) return null;

  const sa = snap.docs[0].data() as SubAccountDoc;
  // Gate off: treat the channel as nonexistent.
  if (sa.whatsappEnabledByAgency !== true) {
    console.warn(
      `[twilio/whatsapp] inbound to ${normalisedTo} (sa=${snap.docs[0].id}) but whatsappEnabledByAgency is off — dropping`,
    );
    return null;
  }
  if (!sa.twilioConfig?.authToken) return null;

  return {
    authToken: sa.twilioConfig.authToken,
    subAccountId: snap.docs[0].id,
    agencyId: sa.agencyId,
  };
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  const params = Object.fromEntries(new URLSearchParams(rawBody).entries());

  const fromRaw = (params["From"] as string | undefined) ?? "";
  const toRaw = (params["To"] as string | undefined) ?? "";
  const bodyRaw = (params["Body"] as string | undefined) ?? "";
  const messageSid = (params["MessageSid"] as string | undefined) ?? "";
  const from = normalisePhone(stripWhatsappPrefix(fromRaw));
  const to = normalisePhone(stripWhatsappPrefix(toRaw));

  const route = await resolveRoute(to);
  if (!route) {
    return twimlResponse(emptyTwimlResponse());
  }

  const signature = request.headers.get("x-twilio-signature");
  if (!signature) {
    console.warn("[twilio/whatsapp] missing X-Twilio-Signature header");
    return twimlResponse(emptyTwimlResponse());
  }

  // Twilio signs the raw params (with prefixes), so pass `params` unmodified.
  const proto = request.headers.get("x-forwarded-proto") ?? "https";
  const host =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const url = new URL(request.url);
  const fullUrl = `${proto}://${host ?? url.host}${url.pathname}`;
  const valid = twilio.validateRequest(
    route.authToken,
    signature,
    fullUrl,
    params,
  );
  if (!valid) {
    console.warn(
      `[twilio/whatsapp] invalid signature (sa=${route.subAccountId})`,
    );
    return new NextResponse("Invalid signature", { status: 403 });
  }

  if (!from) {
    return twimlResponse(emptyTwimlResponse());
  }

  const word = bodyRaw.trim().toUpperCase().split(/\s+/)[0] ?? "";
  let nextOptedOut: boolean | null = null;
  if (STOP_WORDS.has(word)) nextOptedOut = true;
  else if (START_WORDS.has(word)) nextOptedOut = false;

  const db = getAdminDb();
  const profileName =
    (params["ProfileName"] as string | undefined)?.trim() ?? "";

  const matches = await db
    .collection("contacts")
    .where("phone", "==", from)
    .where("subAccountId", "==", route.subAccountId)
    .limit(5)
    .get();

  // Auto-create unknown senders, but don't mint a contact just to opt it out
  // on a first-message STOP/START; drop those.
  let contactDocs: DocumentSnapshot[] = matches.docs;
  if (matches.empty) {
    if (nextOptedOut !== null) {
      return twimlResponse(emptyTwimlResponse());
    }
    try {
      const created = await createContactServerSide({
        subAccountId: route.subAccountId,
        agencyId: route.agencyId ?? "",
        createdByUid: "twilio-whatsapp-inbound",
        mode: "live",
        name: profileName,
        email: "",
        phone: from,
        company: "",
        address: "",
        source: "whatsapp",
        tags: [],
      });
      contactDocs = [await db.collection("contacts").doc(created.id).get()];
    } catch (err) {
      console.error(
        `[twilio/whatsapp] failed to auto-create contact for ${from} (sa=${route.subAccountId})`,
        err,
      );
      return twimlResponse(emptyTwimlResponse());
    }
  }

  // Write the row before opt-out handling so it keeps the actual word sent.
  {
    const docId = messageSid || db.collection("contacts").doc().id;
    const writes = contactDocs.map((d) =>
      d.ref
        .collection("whatsappMessages")
        .doc(docId)
        .set(
          {
            agencyId: route.agencyId,
            subAccountId: route.subAccountId,
            contactId: d.id,
            direction: "inbound",
            status: "received",
            body: bodyRaw,
            from,
            to,
            twilioMessageSid: messageSid || null,
            sentByUid: null,
            error: null,
            readAt: null,
            createdAt: FieldValue.serverTimestamp(),
          },
          { merge: true }, // Twilio retries with the same MessageSid
        ),
    );
    try {
      await Promise.all(writes);
    } catch (err) {
      console.warn("[twilio/whatsapp] message-row write failed", err);
    }

    // One inbox conversation per matched contact.
    await Promise.all(
      contactDocs.map((d) => {
        const cdata = d.data() as { name?: string; phone?: string } | undefined;
        return upsertConversationForMessage({
          contactId: d.id,
          subAccountId: route.subAccountId,
          agencyId: route.agencyId ?? "",
          contactName: cdata?.name ?? "",
          contactPhone: cdata?.phone ?? from,
          channel: "whatsapp",
          direction: "inbound",
          body: bodyRaw,
        });
      }),
    );
  }

  if (nextOptedOut !== null) {
    const batch = db.batch();
    for (const docSnap of contactDocs) {
      batch.update(docSnap.ref, {
        whatsappOptedOut: nextOptedOut,
        updatedAt: FieldValue.serverTimestamp(),
      });
      batch.set(docSnap.ref.collection("activities").doc(), {
        type: "automation_step_skipped",
        content: nextOptedOut
          ? `WhatsApp opt-out (${word}) received from ${from}.`
          : `WhatsApp opt-in (${word}) received from ${from}.`,
        createdBy: "twilio_whatsapp_inbound",
        meta: { kind: "whatsapp_opt_out", word, optedOut: nextOptedOut },
        createdAt: FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
    return twimlResponse(emptyTwimlResponse());
  }

  if (contactDocs.length > 0 && aiIsConfigured()) {
    try {
      const agent = await resolveAgent(route.subAccountId, "whatsapp");
      if (agent?.effective.enabled) {
        const contactDoc = contactDocs[0];
        const contact = {
          id: contactDoc.id,
          ...(contactDoc.data() as Omit<Contact, "id">),
        };
        const saSnap = await db.doc(`subAccounts/${route.subAccountId}`).get();
        const subAccount = saSnap.data() as SubAccountDoc | undefined;
        if (subAccount) {
          await maybeRespondWithAi({
            subAccountId: route.subAccountId,
            subAccount,
            agent,
            channelId: "whatsapp",
            contact,
            incomingMessage: bodyRaw,
            replyTo: from,
          });
        }
      }
    } catch (err) {
      console.error(
        `[twilio/whatsapp] AI reply pipeline failed for sa=${route.subAccountId}`,
        err,
      );
    }
  }

  return twimlResponse(emptyTwimlResponse());
}
