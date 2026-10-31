import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { GLOBAL_TERRITORY_ID } from "@/types";
import { fireWorkflowTrigger } from "@/lib/workflows/engine";
import { emitWebhookEvent } from "@/lib/api/webhooks/dispatch";
import { serializeContactForApi } from "@/lib/api/serializers/contacts";
import { emitContactCreatedById } from "@/lib/server/contacts-service";
import { emitDealCreatedById } from "@/lib/server/deals-service";
import { runAfterResponse } from "@/lib/server/after-response";
import {
  EMPTY_LOCATION,
  ipFromRequest,
  locationFromIp,
  locationFromPhone,
  mergeLocation,
} from "@/lib/contacts/location";
import { normalizePhoneE164 } from "@/lib/contacts/phone";
import {
  checkFormSpam,
  ELAPSED_BODY_KEY,
  HONEYPOT_BODY_KEY,
} from "@/lib/forms/spam-guard";
import { safeFormRedirectUrl } from "@/lib/forms/redirect";
import { defaultSmsConsentText } from "@/types/forms";
import type { FormField, LeadForm } from "@/types/forms";
import type { Contact, ContactAttribution } from "@/types/contacts";

type SubmitBody = {
  values: Record<string, string>;
  attribution?: Partial<ContactAttribution>;
  /** Honeypot (see lib/forms/spam-guard). Optional; non-empty = bot. */
  [HONEYPOT_BODY_KEY]?: unknown;
  /** Client-measured time-on-form in ms. Optional; too small = bot. */
  [ELAPSED_BODY_KEY]?: unknown;
};

const ATTRIBUTION_KEYS: (keyof ContactAttribution)[] = [
  "utmSource",
  "utmMedium",
  "utmCampaign",
  "utmContent",
  "utmTerm",
  "fbclid",
  "gclid",
  "landingPage",
  "referrer",
];

function normalizeAttribution(
  input: Partial<ContactAttribution> | undefined,
): ContactAttribution | null {
  if (!input || typeof input !== "object") return null;
  const out: ContactAttribution = {
    utmSource: null,
    utmMedium: null,
    utmCampaign: null,
    utmContent: null,
    utmTerm: null,
    fbclid: null,
    gclid: null,
    landingPage: null,
    referrer: null,
  };
  let touched = false;
  for (const key of ATTRIBUTION_KEYS) {
    const raw = input[key];
    if (typeof raw === "string" && raw.trim().length > 0) {
      out[key] = raw.trim().slice(0, 500);
      touched = true;
    }
  }
  return touched ? out : null;
}

function interpolate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_m, key: string) => values[key] ?? "");
}

function contactFieldsFromSubmission(
  fields: FormField[],
  values: Record<string, string>,
): {
  name: string;
  email: string;
  phone: string;
  company: string;
  notes: string;
} {
  const out = { name: "", email: "", phone: "", company: "", notes: "" };
  for (const f of fields) {
    if (!f.mapsTo) continue;
    const v = (values[f.id] ?? "").toString().trim();
    if (!v) continue;
    out[f.mapsTo] = v;
  }
  return out;
}

/**
 * Wildcard origin on purpose: the "Copy HTML snippet" embed can go on any
 * third-party site. Same-domain submits (iframe, /f/[id]) work regardless.
 */
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

function jsonWithCors(body: unknown, init?: ResponseInit) {
  return NextResponse.json(body, {
    ...init,
    headers: { ...(init?.headers ?? {}), ...CORS_HEADERS },
  });
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    return await handleSubmit(request, ctx);
  } catch (err) {
    // Keep CORS headers on unhandled errors, otherwise the browser reports a
    // misleading CORS failure instead of the real error.
    console.error("[forms/submit] unhandled error:", err);
    const message = err instanceof Error ? err.message : "Internal error";
    return jsonWithCors({ error: message }, { status: 500 });
  }
}

async function handleSubmit(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  let body: SubmitBody;
  try {
    body = (await request.json()) as SubmitBody;
  } catch {
    return jsonWithCors({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body || typeof body.values !== "object") {
    return jsonWithCors({ error: "Missing values" }, { status: 400 });
  }

  // Honeypot, time-on-form and per-IP rate limit. Runs before any Firestore
  // read so a hammering bot costs a map lookup. Trap verdicts are acted on
  // after the form loads so the fake success can mirror the real one.
  const spam = checkFormSpam({
    ip: ipFromRequest(request),
    formId: id,
    honeypot: body[HONEYPOT_BODY_KEY],
    elapsedMs: body[ELAPSED_BODY_KEY],
  });
  if (spam.kind === "rate_limited") {
    return jsonWithCors(
      {
        error:
          "Too many submissions from your network. Please wait a few minutes and try again.",
      },
      {
        status: 429,
        headers: { "Retry-After": String(spam.retryAfterSec) },
      },
    );
  }

  const db = getAdminDb();
  const formRef = db.collection("forms").doc(id);
  const formSnap = await formRef.get();
  if (!formSnap.exists) {
    return jsonWithCors({ error: "Form not found" }, { status: 404 });
  }
  const form = { id: formSnap.id, ...(formSnap.data() as Omit<LeadForm, "id">) };
  if (!form.enabled) {
    return jsonWithCors({ error: "Form is paused" }, { status: 410 });
  }

  if (spam.kind === "trap") {
    // Fake success with the same shape and thank-you copy, so the bot can't
    // tell. Nothing is written or sent.
    console.warn(
      `[forms/submit] spam trap (${spam.reason}) form=${id} sa=${form.subAccountId}`,
    );
    return jsonWithCors({
      ok: true,
      contactId: null,
      dealId: null,
      thankYouMessage: form.settings.thankYouMessage,
      redirectUrl: safeFormRedirectUrl(form.settings.redirectUrl, request.url),
    });
  }

  // Tenancy: everything this submission creates inherits the form's
  // sub-account and agency.
  const agencyId = form.agencyId;
  const subAccountId = form.subAccountId;
  if (!agencyId || !subAccountId) {
    return jsonWithCors(
      { error: "Form is missing tenancy metadata" },
      { status: 500 },
    );
  }

  for (const field of form.fields) {
    if (!field.required) continue;
    if (field.type === "sms_consent") {
      // Consent only counts as an explicit "true"; a direct POST could send
      // "false" or "on".
      if (body.values[field.id] !== "true") {
        return jsonWithCors(
          { error: "SMS consent is required to submit this form." },
          { status: 400 },
        );
      }
      continue;
    }
    const v = body.values[field.id];
    if (!v || !v.toString().trim()) {
      return jsonWithCors(
        { error: `Missing required field: ${field.label}` },
        { status: 400 },
      );
    }
  }

  // A2P 10DLC: when the form has an sms_consent field, the checkbox is the
  // opt-in (checked = opted in + audit record, unchecked = no consent, never
  // SMS). Forms without one keep the default smsOptedOut: false.
  const consentField = form.fields.find((f) => f.type === "sms_consent");
  const consentChecked = consentField
    ? body.values[consentField.id] === "true"
    : false;

  const mapped = contactFieldsFromSubmission(form.fields, body.values);
  const attribution = normalizeAttribution(body.attribution);

  // E.164 before dedupe/storage. Strict here: an unparseable number is a 400
  // with a fixable message (also stops direct POSTs storing junk).
  // defaultPhoneCountry only applies to bare national numbers.
  if (mapped.phone.trim()) {
    const subSnap = await db.doc(`subAccounts/${subAccountId}`).get();
    const e164 = normalizePhoneE164(
      mapped.phone,
      (subSnap.data()?.defaultPhoneCountry as string) ?? null,
    );
    if (!e164) {
      return jsonWithCors(
        {
          error:
            "Please enter a valid phone number — include your country code (e.g. +1) if you're outside the region.",
        },
        { status: 400 },
      );
    }
    mapped.phone = e164;
  }

  const bag: Record<string, string> = { ...mapped };
  for (const f of form.fields) {
    bag[f.id] = body.values[f.id] ?? "";
  }

  // No authed caller here, so the form creator stands in as createdBy.
  const submissionCreatedBy = form.createdByUid || "form-submission";

  // Best-effort location: IP geo first (city + lat/lng), phone country code as
  // fallback. Both fail soft; the contact saves with null location.
  const ip = ipFromRequest(request);
  const [ipLoc, phoneLoc] = await Promise.all([
    ip ? locationFromIp(ip) : Promise.resolve(EMPTY_LOCATION),
    Promise.resolve(locationFromPhone(mapped.phone)),
  ]);
  const location = mergeLocation(ipLoc, phoneLoc);

  // Dedupe email-first, then phone, within the sub-account (same shape as
  // lib/booking/contact-reconcile.ts and the web-chat/voice capture paths).
  // Two equality filters, no composite index. Email is lowercased so case
  // variants reconcile to one contact.
  const matchEmail = mapped.email.trim().toLowerCase();
  const matchPhone = mapped.phone.trim();

  async function findExistingContact() {
    if (matchEmail) {
      const byEmail = await db
        .collection("contacts")
        .where("subAccountId", "==", subAccountId)
        .where("email", "==", matchEmail)
        .limit(1)
        .get();
      if (!byEmail.empty) return byEmail.docs[0];
    }
    if (matchPhone) {
      const byPhone = await db
        .collection("contacts")
        .where("subAccountId", "==", subAccountId)
        .where("phone", "==", matchPhone)
        .limit(1)
        .get();
      if (!byPhone.empty) return byPhone.docs[0];
    }
    return null;
  }

  const existingContact = await findExistingContact();
  let contactRef: FirebaseFirestore.DocumentReference;
  let contactCreated: boolean;

  if (existingContact) {
    // Reuse + enrich: fill only blank identity fields and merge tags, never
    // clobber operator data. First-touch attribution is only set if missing.
    // SMS consent/opt-out are left alone on existing contacts (compliance);
    // consent is only stamped at create time.
    contactRef = existingContact.ref;
    contactCreated = false;
    const data = existingContact.data() as Partial<Contact>;
    const patch: Record<string, unknown> = {};
    if (mapped.name && !data.name) patch.name = mapped.name;
    if (mapped.phone && !data.phone) patch.phone = mapped.phone;
    if (matchEmail && !data.email) patch.email = matchEmail;
    if (mapped.company && !data.company) patch.company = mapped.company;
    const newTags = form.settings.autoTags ?? [];
    if (newTags.length > 0) {
      const existingTags = Array.isArray(data.tags) ? data.tags : [];
      const mergedTags = Array.from(new Set([...existingTags, ...newTags]));
      if (mergedTags.length !== existingTags.length) patch.tags = mergedTags;
    }
    if (attribution && !data.attribution) patch.attribution = attribution;
    if (Object.keys(patch).length > 0) {
      patch.updatedAt = FieldValue.serverTimestamp();
      try {
        await contactRef.update(patch);
      } catch {
        // Non-fatal; the submission still lands.
      }
    }
  } else {
    contactRef = await db.collection("contacts").add({
      name: mapped.name,
      email: matchEmail,
      phone: mapped.phone,
      company: mapped.company,
      address: "",
      // "website-form" lets the badge tell form submissions apart from web-chat
      // and manual website contacts. UTM source wins when present.
      source: attribution?.utmSource || "website-form",
      tags: form.settings.autoTags ?? [],
      pipelineStage: form.settings.pipelineStageId ?? null,
      attribution,
      agencyId,
      subAccountId,
      createdByUid: submissionCreatedBy,
      emailOptedOut: false,
      // Never set here: smsOptedOut means a carrier STOP (Twilio inbound only).
      // A declined checkbox goes on `smsConsent.consented`, which
      // lib/comms/sms-consent.ts::smsSendBlock() enforces at every sender.
      smsOptedOut: false,
      ...(consentField
        ? {
            smsConsent: {
              consented: consentChecked,
              textShown:
                consentField.consentText?.trim() || defaultSmsConsentText(),
              consentedAt: consentChecked
                ? FieldValue.serverTimestamp()
                : null,
              sourceUrl: attribution?.landingPage ?? null,
              ip: ip ?? null,
            },
          }
        : {}),
      countryCode: location.countryCode,
      country: location.country,
      city: location.city,
      lat: location.lat,
      lng: location.lng,
      // Inbound leads start in Global until an admin routes them. Harmless when
      // scoping is off.
      territoryId: GLOBAL_TERRITORY_ID,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    contactCreated = true;
  }

  if (mapped.notes) {
    await db
      .collection("contacts")
      .doc(contactRef.id)
      .collection("notes")
      .add({
        content: mapped.notes,
        createdBy: submissionCreatedBy,
        createdAt: FieldValue.serverTimestamp(),
      });
  }

  // Optionally open a deal in the configured stage.
  let dealId: string | null = null;
  if (form.settings.createDeal) {
    const stageId = form.settings.pipelineStageId ?? "new";
    const title =
      interpolate(form.settings.dealTitleTemplate || "New lead", bag) ||
      "New lead";
    const dealRef = await db.collection("deals").add({
      title,
      value: form.settings.dealValue || 0,
      currency: form.settings.dealCurrency || "USD",
      contactId: contactRef.id,
      stageId,
      priority: "medium",
      agencyId,
      subAccountId,
      createdByUid: submissionCreatedBy,
      lostReason: null,
      // Same Global default as the contact.
      territoryId: GLOBAL_TERRITORY_ID,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      stageChangedAt: FieldValue.serverTimestamp(),
    });
    dealId = dealRef.id;
  }

  // Admin-only write; rules deny client writes.
  const submissionRef = await formRef.collection("submissions").add({
    formId: id,
    values: body.values,
    contactId: contactRef.id,
    dealId,
    createdAt: FieldValue.serverTimestamp(),
  });

  await formRef.update({
    submissionCount: FieldValue.increment(1),
    updatedAt: FieldValue.serverTimestamp(),
  });

  // dealId may be null (valid in Firestore; undefined is not).
  await db
    .collection("contacts")
    .doc(contactRef.id)
    .collection("activities")
    .add({
      type: "form_submitted",
      content: `Submitted form "${form.name}"`,
      createdBy: submissionCreatedBy,
      meta: { formId: id, dealId },
      createdAt: FieldValue.serverTimestamp(),
    });

  // Workflows are fire-and-forget; the contact is already saved. Submitted
  // answers (label -> value) are forwarded so a Webhook step can pass them on.
  const formData: Record<string, string> = {};
  for (const f of form.fields) {
    const v = (body.values?.[f.id] ?? "").toString().trim();
    if (v) formData[f.label] = v;
  }
  void fireWorkflowTrigger({
    agencyId,
    subAccountId,
    type: "form.submitted",
    contactId: contactRef.id,
    context: { formId: id, formName: form.name, formData },
  });

  // Outbound webhooks, same events as a manual or API create. Public forms
  // have no test mode. contact.created only fires for a newly minted contact,
  // not a deduped resubmit.
  if (contactCreated) {
    void emitContactCreatedById({
      subAccountId,
      agencyId,
      contactId: contactRef.id,
    });
  }
  if (dealId) {
    void emitDealCreatedById({ subAccountId, agencyId, dealId });
  }
  // Same payload shape as the public-API submissions endpoint. Scheduled
  // before the contact read so Vercel can't freeze the function mid-read.
  runAfterResponse(async () => {
    try {
      const csnap = await db.collection("contacts").doc(contactRef.id).get();
      await emitWebhookEvent({
        subAccountId,
        agencyId,
        mode: "live",
        type: "form.submitted",
        payload: {
          submission: {
            id: submissionRef.id,
            object: "form_submission",
            form_id: id,
            contact: serializeContactForApi(contactRef.id, csnap.data() ?? {}, "live"),
            values: body.values,
          },
        },
      });
    } catch (err) {
      console.warn("[forms/submit] form.submitted emit failed", err);
    }
  });

  return jsonWithCors({
    ok: true,
    contactId: contactRef.id,
    dealId,
    thankYouMessage: form.settings.thankYouMessage,
    redirectUrl: safeFormRedirectUrl(form.settings.redirectUrl, request.url),
  });
}
