import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import type { QueryDocumentSnapshot } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { normalizePhoneLenient } from "@/lib/contacts/phone";
import { emitContactCreatedById } from "@/lib/server/contacts-service";
import { GLOBAL_TERRITORY_ID } from "@/types";
import type { Contact } from "@/types/contacts";

/**
 * Identity capture shared by web chat and voice. The LLM ends its reply with
 * a marker:
 *
 *   [[capture name="Jane Doe" email="jane@x.com" phone="+61400000000"]]
 *   [[form fields="name,email,phone"]]
 *
 * The parsers strip it and return the clean text; reconcileContactFromCapture
 * finds or creates the Contact. Linking the session (webChatSessions,
 * voiceCalls) is left to each caller.
 */

const MARKER_RE = /\[\[capture\s+([^\]]+)\]\]/i;
const FORM_MARKER_RE = /\[\[form\s+([^\]]+)\]\]/i;
const FIELD_RE = /(name|email|phone)="([^"]+)"/gi;
const FORM_FIELDS_RE = /fields="([^"]+)"/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9][\d\s\-().]{5,}$/;

export type CaptureFieldId = "name" | "email" | "phone";

export interface ParsedFormRequest {
  /** Reply with the [[form ...]] marker removed. */
  cleanText: string;
  /** null when there was no form marker. */
  fields: CaptureFieldId[] | null;
}

/**
 * Parse [[form fields="..."]], keeping the bot's field order so the widget
 * renders inputs in sequence. Harmless on voice transcripts (no marker, no fields).
 */
export function parseFormMarker(rawText: string): ParsedFormRequest {
  const match = FORM_MARKER_RE.exec(rawText);
  if (!match) return { cleanText: rawText, fields: null };

  const inner = match[1] ?? "";
  const fieldsMatch = FORM_FIELDS_RE.exec(inner);
  const fields: CaptureFieldId[] = [];
  if (fieldsMatch && fieldsMatch[1]) {
    const seen = new Set<string>();
    for (const raw of fieldsMatch[1].split(",")) {
      const f = raw.trim().toLowerCase();
      if ((f === "name" || f === "email" || f === "phone") && !seen.has(f)) {
        seen.add(f);
        fields.push(f);
      }
    }
  }

  const cleanText = rawText
    .replace(FORM_MARKER_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (fields.length === 0) {
    return { cleanText, fields: null };
  }

  return { cleanText, fields };
}

export interface ParsedCapture {
  /** Marker removed. Web chat shows it; voice discards it. */
  cleanText: string;
  /** null if no marker. Fields the LLM left out are null. */
  capture: {
    name: string | null;
    email: string | null;
    phone: string | null;
  } | null;
}

export function parseCaptureMarker(rawText: string): ParsedCapture {
  const match = MARKER_RE.exec(rawText);
  if (!match) {
    return { cleanText: rawText, capture: null };
  }

  const inner = match[1] ?? "";
  let name: string | null = null;
  let email: string | null = null;
  let phone: string | null = null;

  for (const m of inner.matchAll(FIELD_RE)) {
    const key = m[1]?.toLowerCase();
    const value = m[2]?.trim();
    if (!value) continue;
    if (key === "name") name = value.slice(0, 200);
    else if (key === "email" && EMAIL_RE.test(value)) email = value;
    else if (key === "phone" && PHONE_RE.test(value)) phone = value;
  }

  const cleanText = rawText.replace(MARKER_RE, "").replace(/\n{3,}/g, "\n\n").trim();

  if (!name && !email && !phone) {
    return { cleanText, capture: null };
  }

  return { cleanText, capture: { name, email, phone } };
}

export interface ReconcileInput {
  agencyId: string;
  subAccountId: string;
  /** When set, skip reconciliation (e.g. caller already matched by number). */
  existingContactId: string | null;
  /** Saved as attribution.landingPage. Web chat passes the page URL; voice passes null. */
  pageUrl: string | null;
  /** e.g. "web-chat" | "voice". Drives the source badge. */
  source: string;
  /**
   * Which identifier to try first; the other is the fallback. Web chat is
   * email-first (typed on purpose), voice is phone-first (caller ID is always known).
   */
  matchStrategy: "email-first" | "phone-first";
  capture: NonNullable<ParsedCapture["capture"]>;
}

export interface ReconcileResult {
  contactId: string;
  /** false when an existing match was reused or the session was already linked. */
  created: boolean;
}

/**
 * Find or create the Contact. Short-circuits when existingContactId is set.
 * Returns null with no email or phone: creating from a name alone risks
 * storing a hallucination.
 *
 * On a match, blank name/email/phone are filled from the capture (like the
 * booking reconciler) so details offered mid-conversation aren't lost. Existing
 * data is never overwritten.
 */
export async function reconcileContactFromCapture(
  input: ReconcileInput,
): Promise<ReconcileResult | null> {
  if (input.existingContactId) {
    return { contactId: input.existingContactId, created: false };
  }

  if (!input.capture.email && !input.capture.phone) return null;

  const db = getAdminDb();
  const contactsCol = db.collection("contacts");

  // Normalize to E.164 so stored phones match the `From` the Twilio inbound
  // webhooks query with. Unparseable numbers keep the typed string. Match on
  // the normalized form first, then the typed one, so older un-normalized
  // contacts still match.
  const typedPhone = input.capture.phone;
  let phone = typedPhone;
  if (typedPhone) {
    const subSnap = await db.doc(`subAccounts/${input.subAccountId}`).get();
    phone = normalizePhoneLenient(
      typedPhone,
      (subSnap.data()?.defaultPhoneCountry as string | null) ?? null,
    );
  }

  const tryEmailMatch =
    async (): Promise<QueryDocumentSnapshot | null> => {
      if (!input.capture.email) return null;
      const snap = await contactsCol
        .where("subAccountId", "==", input.subAccountId)
        .where("email", "==", input.capture.email)
        .limit(1)
        .get();
      return snap.empty ? null : snap.docs[0];
    };

  const tryPhoneMatch =
    async (): Promise<QueryDocumentSnapshot | null> => {
      if (!phone) return null;
      const candidates =
        typedPhone && typedPhone !== phone ? [phone, typedPhone] : [phone];
      for (const candidate of candidates) {
        const snap = await contactsCol
          .where("subAccountId", "==", input.subAccountId)
          .where("phone", "==", candidate)
          .limit(1)
          .get();
        if (!snap.empty) return snap.docs[0];
      }
      return null;
    };

  const matchOrder =
    input.matchStrategy === "phone-first"
      ? [tryPhoneMatch, tryEmailMatch]
      : [tryEmailMatch, tryPhoneMatch];

  for (const lookup of matchOrder) {
    const hit = await lookup();
    if (hit) {
      await backfillContactFromCapture(hit, { ...input.capture, phone });
      return { contactId: hit.id, created: false };
    }
  }

  const contactRef = await contactsCol.add({
    name: input.capture.name ?? "",
    email: input.capture.email ?? "",
    phone: phone ?? "",
    company: "",
    address: "",
    source: input.source,
    tags: [],
    pipelineStage: null,
    attribution: input.pageUrl ? { landingPage: input.pageUrl } : null,
    agencyId: input.agencyId,
    subAccountId: input.subAccountId,
    createdByUid: `${input.source}-bot`,
    emailOptedOut: false,
    smsOptedOut: false,
    countryCode: null,
    country: null,
    city: null,
    lat: null,
    lng: null,
    // Bot-captured leads go to Global until an admin routes them. Harmless when scoping is off.
    territoryId: GLOBAL_TERRITORY_ID,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  // contact.created fires for any channel. The channel's own event
  // (webchat.lead.captured / voice.call.captured) fires separately.
  void emitContactCreatedById({
    subAccountId: input.subAccountId,
    agencyId: input.agencyId,
    contactId: contactRef.id,
  });

  return { contactId: contactRef.id, created: true };
}

/**
 * Fill only the empty name/email/phone fields. Write errors are swallowed;
 * the contact id is already resolved and capture shouldn't fail on a patch.
 */
async function backfillContactFromCapture(
  doc: QueryDocumentSnapshot,
  capture: NonNullable<ParsedCapture["capture"]>,
): Promise<void> {
  const data = doc.data() as Contact;
  const patch: Record<string, unknown> = {};
  if (capture.name && !data.name?.trim()) patch.name = capture.name;
  if (capture.email && !data.email?.trim()) patch.email = capture.email;
  if (capture.phone && !data.phone?.trim()) patch.phone = capture.phone;
  if (Object.keys(patch).length === 0) return;

  patch.updatedAt = FieldValue.serverTimestamp();
  try {
    await doc.ref.update(patch);
  } catch {
    // Non-fatal; capture still succeeds.
  }
}
