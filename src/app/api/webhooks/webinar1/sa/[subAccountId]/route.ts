import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { verifyWebhookSignature } from "@/lib/api/webhooks/signing";
import { readWebinar1ConnectionSecret } from "@/lib/webinar1/client";
import { logWebinarActivity } from "@/lib/webinar1/activities";
import { createContactServerSide } from "@/lib/server/contacts-service";
import type { ActivityType } from "@/types/contacts";
import type { SubAccountDoc } from "@/types";

export const dynamic = "force-dynamic";

/**
 * POST /api/webhooks/webinar1/sa/{subAccountId}: Webinar1 inbound webhook,
 * registered by the webinar1-connection flow.
 *
 * `X-Webinar1-Signature` is Stripe-style `t=<ts>,v1=<hmac>` over
 * `${ts}.${rawBody}`, the same scheme as our outbound webhooks, so
 * lib/api/webhooks/signing.ts verifies it. The URL id is untrusted and only
 * picks the secret (as with the per-sub-account Stripe receiver).
 *
 * registration.created: reconcile/create the contact by email, log
 * webinar_registered. attendee.joined / attendee.completed / cta.clicked:
 * reconcile and log the matching activity.
 *
 * 200 for everything but a bad signature; non-2xx makes Webinar1 retry and
 * eventually disable the endpoint. Activity ids are deterministic so
 * retries can't double-log.
 */

interface Webinar1Envelope {
  id?: string;
  event?: string;
  createdAt?: string;
  data?: {
    webinar?: { id?: string; slug?: string; title?: string };
    registration?: {
      id?: string;
      email?: string;
      name?: string | null;
      maxWatchPercent?: number;
    };
    ctaUrl?: string;
  };
}

/**
 * Find or create the contact by email. Single-field equality plus an
 * in-code tenancy filter, so no composite index (same as the Meta receiver).
 */
async function reconcileContactByEmail(input: {
  subAccountId: string;
  agencyId: string;
  email: string;
  name: string | null;
  createIfMissing: boolean;
}): Promise<string | null> {
  const db = getAdminDb();
  const matches = await db
    .collection("contacts")
    .where("email", "==", input.email)
    .limit(10)
    .get();
  const existing = matches.docs.find(
    (d) => (d.data().subAccountId as string) === input.subAccountId
  );
  if (existing) return existing.id;
  if (!input.createIfMissing) return null;

  try {
    const created = await createContactServerSide({
      subAccountId: input.subAccountId,
      agencyId: input.agencyId,
      createdByUid: "webinar1-webhook",
      mode: "live",
      name: input.name ?? "",
      email: input.email,
      phone: "",
      company: "",
      address: "",
      source: "webinar",
      tags: [],
    });
    return created.id;
  } catch (err) {
    console.error(
      `[webhooks/webinar1] contact create failed sa=${input.subAccountId}`,
      err
    );
    return null;
  }
}

const EVENT_ACTIVITY: Record<string, { type: ActivityType; verb: string }> = {
  "registration.created": {
    type: "webinar_registered",
    verb: "Registered for",
  },
  "attendee.joined": { type: "webinar_joined", verb: "Joined" },
  "attendee.completed": {
    type: "webinar_completed",
    verb: "Watched to the end of",
  },
  "cta.clicked": {
    type: "webinar_cta_clicked",
    verb: "Clicked the offer in",
  },
};

export async function POST(
  request: Request,
  ctx: { params: Promise<{ subAccountId: string }> }
) {
  const { subAccountId } = await ctx.params;
  const rawBody = await request.text();

  const secret = await readWebinar1ConnectionSecret(subAccountId);
  if (!secret?.webhookSecret) {
    // Unknown or half-connected sub-account: nothing to verify against. 200 so
    // a stale endpoint doesn't retry-storm.
    return NextResponse.json({ ok: true, ignored: "not_configured" });
  }

  const verdict = verifyWebhookSignature({
    secret: secret.webhookSecret,
    rawBody,
    header: request.headers.get("x-webinar1-signature"),
  });
  if (!verdict.ok) {
    return NextResponse.json(
      { error: `Invalid signature (${verdict.reason})` },
      { status: 403 }
    );
  }

  let envelope: Webinar1Envelope;
  try {
    envelope = JSON.parse(rawBody) as Webinar1Envelope;
  } catch {
    return NextResponse.json({ ok: true, ignored: "bad_json" });
  }

  const mapping = envelope.event ? EVENT_ACTIVITY[envelope.event] : undefined;
  const registration = envelope.data?.registration;
  const email = registration?.email?.trim() ?? "";
  const registrationId = registration?.id ?? "";
  if (!mapping || !email || !registrationId) {
    // `ping`, unknown types, or unattributable payloads.
    return NextResponse.json({
      ok: true,
      ignored: envelope.event ?? "unknown",
    });
  }

  const subSnap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  const sub = subSnap.data() as SubAccountDoc | undefined;
  if (!sub) {
    return NextResponse.json({ ok: true, ignored: "no_sub_account" });
  }
  // 200, not 403, so the platform doesn't disable an endpoint that works
  // again once the agency re-enables the feature.
  if (sub.webinar1EnabledByAgency !== true) {
    console.warn(
      `[webhooks/webinar1] event for sa=${subAccountId} but webinar1EnabledByAgency is off — dropping`
    );
    return NextResponse.json({ ok: true, ignored: "gate_off" });
  }

  const contactId = await reconcileContactByEmail({
    subAccountId,
    agencyId: sub.agencyId,
    email,
    name: registration?.name ?? null,
    createIfMissing: true,
  });
  if (!contactId) {
    return NextResponse.json({ ok: true, ignored: "contact_failed" });
  }

  const webinar = envelope.data?.webinar;
  const title = webinar?.title ?? "";
  const watch =
    envelope.event === "attendee.completed" &&
    typeof registration?.maxWatchPercent === "number"
      ? registration.maxWatchPercent
      : null;

  try {
    await logWebinarActivity(contactId, {
      type: mapping.type,
      content: `${mapping.verb} ${title ? `"${title}"` : "a webinar"}${
        watch !== null ? ` (${watch}% watched)` : ""
      }`,
      createdBy: "webinar1-webhook",
      meta: {
        ...(webinar?.id ? { webinarId: webinar.id } : {}),
        ...(webinar?.slug ? { webinarSlug: webinar.slug } : {}),
        webinarRegistrationId: registrationId,
        ...(watch !== null ? { webinarWatchPercent: watch } : {}),
      },
      // One row per (type, registration): retries collapse, repeat CTA clicks
      // stay one row, and the echo of a CRM-side push lands on the row the
      // register route wrote.
      dedupeKey: `${mapping.type}_${registrationId}`,
    });
  } catch (err) {
    // Activity rows are a convenience; failing would retry reconciliation too.
    console.error(
      `[webhooks/webinar1] activity write failed sa=${subAccountId}`,
      err
    );
  }

  return NextResponse.json({ ok: true });
}
