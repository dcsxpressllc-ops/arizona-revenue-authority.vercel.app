import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import twilio from "twilio";
import { getAdminDb } from "@/lib/firebase/admin";
import { resolveAgent } from "@/lib/comms/ai/agent";
import { maybeRespondWithAi } from "@/lib/comms/ai/respond";
import { aiChannelGateOn } from "@/lib/comms/ai/gates";
import { aiIsConfigured } from "@/lib/comms/ai/openrouter";
import { upsertConversationForMessage } from "@/lib/server/conversations-service";
import type { SubAccountDoc } from "@/types";
import type { Contact } from "@/types/contacts";

export const dynamic = "force-dynamic";

/**
 * Twilio inbound SMS webhook, two modes on one URL.
 * Shared: To matches TWILIO_FROM_NUMBER, signature checked with
 * TWILIO_AUTH_TOKEN. STOP/START handling only; nothing stored.
 * Dedicated: To matches an enabled sub-account's `twilioConfig.fromNumber`,
 * signature checked with that sub-account's authToken. STOP/START flips
 * `smsOptedOut`, and every message is stored in `contacts/{id}/messages`.
 *
 * Dedicated is looked up first, so it wins if a number is configured both
 * ways. Always 200 + empty TwiML; dropped messages are only logged.
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
  mode: "shared" | "dedicated";
  authToken: string;
  /** Dedicated mode only; scopes contact lookups. */
  subAccountId: string | null;
  agencyId: string | null;
}

/** Mode for this To number, or null if nothing matches (drop with 200). */
async function resolveRoute(
  toNumber: string,
): Promise<ResolvedRoute | null> {
  if (!toNumber) return null;
  const normalisedTo = normalisePhone(toNumber);

  const dedicated = await getAdminDb()
    .collection("subAccounts")
    .where("twilioConfig.fromNumber", "==", normalisedTo)
    .where("twilioConfig.enabled", "==", true)
    .limit(1)
    .get();
  if (!dedicated.empty) {
    const sa = dedicated.docs[0].data() as SubAccountDoc;
    if (sa.twilioConfig?.authToken) {
      return {
        mode: "dedicated",
        authToken: sa.twilioConfig.authToken,
        subAccountId: dedicated.docs[0].id,
        agencyId: sa.agencyId,
      };
    }
  }

  const envFrom = process.env.TWILIO_FROM_NUMBER
    ? normalisePhone(process.env.TWILIO_FROM_NUMBER)
    : null;
  const envToken = process.env.TWILIO_AUTH_TOKEN ?? null;
  if (envFrom && envToken && envFrom === normalisedTo) {
    return {
      mode: "shared",
      authToken: envToken,
      subAccountId: null,
      agencyId: null,
    };
  }

  return null;
}

export async function POST(request: Request) {
  // Form-encoded. Parse first so we can route by To before checking the
  // signature.
  const rawBody = await request.text();
  const params = Object.fromEntries(
    new URLSearchParams(rawBody).entries(),
  );

  const fromRaw = (params["From"] as string | undefined) ?? "";
  const toRaw = (params["To"] as string | undefined) ?? "";
  const bodyRaw = (params["Body"] as string | undefined) ?? "";
  const messageSid = (params["MessageSid"] as string | undefined) ?? "";
  const from = normalisePhone(fromRaw);
  const to = normalisePhone(toRaw);

  const route = await resolveRoute(to);
  if (!route) {
    console.warn(
      `[twilio/inbound] inbound to ${to || "(missing)"} matched no configured number — dropping`,
    );
    return twimlResponse(emptyTwimlResponse());
  }

  const signature = request.headers.get("x-twilio-signature");
  if (!signature) {
    console.warn("[twilio/inbound] missing X-Twilio-Signature header");
    return twimlResponse(emptyTwimlResponse());
  }

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
      `[twilio/inbound] invalid signature (mode=${route.mode}, sa=${route.subAccountId ?? "n/a"})`,
    );
    return new NextResponse("Invalid signature", { status: 403 });
  }

  if (!from) {
    return twimlResponse(emptyTwimlResponse());
  }

  // First word, upper-cased.
  const word = bodyRaw.trim().toUpperCase().split(/\s+/)[0] ?? "";
  let nextOptedOut: boolean | null = null;
  if (STOP_WORDS.has(word)) nextOptedOut = true;
  else if (START_WORDS.has(word)) nextOptedOut = false;

  // Shared mode matches across all contacts (legacy). Dedicated mode is scoped
  // to the sub-account so phones can't leak across tenants.
  const db = getAdminDb();
  let query = db
    .collection("contacts")
    .where("phone", "==", from) as FirebaseFirestore.Query;
  if (route.mode === "dedicated" && route.subAccountId) {
    query = query.where("subAccountId", "==", route.subAccountId);
  }
  const matches = await query.limit(5).get();

  // Dedicated mode: write the message row before opt-out handling so it keeps
  // the actual word sent, STOP/START included.
  if (route.mode === "dedicated" && !matches.empty && route.subAccountId) {
    const docId = messageSid || db.collection("contacts").doc().id;
    const writes = matches.docs.map((d) => {
      const ref = d.ref.collection("messages").doc(docId);
      return ref.set(
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
      );
    });
    try {
      await Promise.all(writes);
    } catch (err) {
      console.warn("[twilio/inbound] message-row write failed", err);
    }

    // One inbox conversation per matched contact.
    await Promise.all(
      matches.docs.map((d) => {
        const cdata = d.data() as { name?: string; phone?: string };
        return upsertConversationForMessage({
          contactId: d.id,
          subAccountId: route.subAccountId!,
          agencyId: route.agencyId ?? "",
          contactName: cdata.name ?? "",
          contactPhone: cdata.phone ?? from,
          channel: "sms",
          direction: "inbound",
          body: bodyRaw,
        });
      }),
    );
  } else if (route.mode === "dedicated" && matches.empty) {
    console.warn(
      `[twilio/inbound] dedicated inbound from ${from} → ${to} (sa=${route.subAccountId}): no contact match — dropping per locked policy`,
    );
  }

  // Opt-out / opt-in (both modes)
  if (nextOptedOut === null) {
    // Not a keyword. Dedicated mode can hand off to the AI auto-reply, which
    // needs the sub-account's own number and persona; shared mode is
    // opt-out-only by design.
    if (
      route.mode === "dedicated" &&
      route.subAccountId &&
      !matches.empty &&
      aiIsConfigured()
    ) {
      try {
        const agent = await resolveAgent(route.subAccountId, "sms");
        if (agent?.effective.enabled) {
          // First contact only; duplicate contacts on one phone shouldn't get N
          // identical replies.
          const contactDoc = matches.docs[0];
          const contact = {
            id: contactDoc.id,
            ...(contactDoc.data() as Omit<Contact, "id">),
          };
          const saSnap = await db
            .doc(`subAccounts/${route.subAccountId}`)
            .get();
          const subAccount = saSnap.data() as SubAccountDoc | undefined;
          // Bot only (manual SMS is unaffected); spends the agency's OpenRouter
          // credits, so the agency must enable the SMS AI channel.
          if (subAccount && aiChannelGateOn(subAccount, "sms")) {
            // Awaited inside the webhook. Twilio allows ~15s; Haiku replies in 1-3s.
            await maybeRespondWithAi({
              subAccountId: route.subAccountId,
              subAccount,
              agent,
              channelId: "sms",
              contact,
              incomingMessage: bodyRaw,
              replyTo: from,
            });
          }
        }
      } catch (err) {
        // AI failures never break the webhook: log and 200.
        console.error(
          `[twilio/inbound] AI reply pipeline failed for sa=${route.subAccountId}`,
          err,
        );
      }
    }

    return twimlResponse(emptyTwimlResponse());
  }

  if (matches.empty) {
    console.warn(
      `[twilio/inbound] ${word} from ${from} (mode=${route.mode}) — no matching contact`,
    );
    return twimlResponse(emptyTwimlResponse());
  }

  const batch = db.batch();
  for (const docSnap of matches.docs) {
    batch.update(docSnap.ref, {
      smsOptedOut: nextOptedOut,
      updatedAt: FieldValue.serverTimestamp(),
    });
    batch.set(docSnap.ref.collection("activities").doc(), {
      type: "automation_step_skipped",
      content: nextOptedOut
        ? `SMS opt-out (${word}) received from ${from}.`
        : `SMS opt-in (${word}) received from ${from}.`,
      createdBy: "twilio_inbound",
      meta: { kind: "sms_opt_out", word, optedOut: nextOptedOut, mode: route.mode },
      createdAt: FieldValue.serverTimestamp(),
    });
  }
  await batch.commit();

  return twimlResponse(emptyTwimlResponse());
}
