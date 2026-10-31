import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import {
  getAgentProfile,
  getChannelConfig,
  type ConfiguredChannelId,
} from "@/lib/comms/ai/agent";
import { aiChannelGateOn } from "@/lib/comms/ai/gates";
import { aiIsConfigured } from "@/lib/comms/ai/openrouter";
import { emailIsConfigured } from "@/lib/comms/resend";
import { qstashIsConfigured } from "@/lib/automations/qstash";
import { getAgentBookingContext } from "@/lib/server/agent-booking-service";
import { DEFAULT_AI_AGENT_PROFILE } from "@/types/ai";
import type { BookingPage } from "@/types/booking";
import type { SubAccountDoc } from "@/types";

/**
 * Setup helpers behind the AI Suite's `ai_booking_readiness` and
 * `configure_ai_booking`. Every read and write is under the ONE sub-account
 * passed in; callers pass the caller's own workspace (ctx.subAccountId),
 * never an id from model output.
 */

export class AiBookingSetupError extends Error {}

export type AiBookingChannel = "web-chat" | "voice" | "messaging";

interface ChannelReport {
  channel: string;
  ready: boolean;
  bookingPage: string | null;
  notes: string[];
}

function pageLabel(page: BookingPage): string {
  return `"${page.name}" (${page.slug}, ${page.durationMinutes} min)`;
}

/** Plain-text readiness report for the assistant. Read-only. */
export async function getAiBookingReadiness(subAccountId: string): Promise<string> {
  const db = getAdminDb();
  const [subSnap, profile, webChat, voice, sms, whatsapp, meta, pagesSnap] =
    await Promise.all([
      db.doc(`subAccounts/${subAccountId}`).get(),
      getAgentProfile(subAccountId),
      getChannelConfig(subAccountId, "web-chat"),
      getChannelConfig(subAccountId, "voice"),
      getChannelConfig(subAccountId, "sms"),
      getChannelConfig(subAccountId, "whatsapp"),
      getChannelConfig(subAccountId, "meta"),
      db.collection(`subAccounts/${subAccountId}/bookingPages`).get(),
    ]);
  if (!subSnap.exists) throw new AiBookingSetupError("This workspace couldn't be loaded.");
  const sub = subSnap.data() as SubAccountDoc;

  const pages = pagesSnap.docs.map((d) => d.data() as BookingPage);
  const bookable = pages.filter((p) => p.status === "published" && !p.payment);
  const bySlug = new Map(pages.map((p) => [p.slug, p]));
  const personaOk = !!profile?.systemPrompt?.trim();
  const aiOk = aiIsConfigured();

  const pageStatus = (slug: string | null | undefined): { label: string | null; ok: boolean; note: string | null } => {
    if (!slug) return { label: null, ok: false, note: "No booking page chosen, so the AI only shares the booking link." };
    const p = bySlug.get(slug);
    if (!p) return { label: slug, ok: false, note: `Booking page "${slug}" no longer exists; pick another.` };
    if (p.status !== "published") return { label: pageLabel(p), ok: false, note: `${pageLabel(p)} isn't published; publish it or pick another.` };
    if (p.payment) return { label: pageLabel(p), ok: false, note: `${pageLabel(p)} takes a deposit, which the AI can't book; pick another.` };
    return { label: pageLabel(p), ok: true, note: null };
  };

  const channel = (
    name: string,
    gateId: ConfiguredChannelId,
    enabled: boolean | undefined,
    slug: string | null | undefined,
    where: string,
    extraNotes: string[] = [],
  ): ChannelReport => {
    const notes: string[] = [];
    const gateOn = aiChannelGateOn(sub, gateId);
    if (!gateOn) notes.push(`Locked by the agency (ask the agency owner to enable it in the sub-account's Manage dialog).`);
    if (!enabled) notes.push(`Channel is off (turn it on under ${where}).`);
    const page = pageStatus(slug);
    if (page.note) notes.push(`${page.note} Set it under ${where}.`);
    notes.push(...extraNotes);
    return {
      channel: name,
      ready: gateOn && !!enabled && page.ok && personaOk && aiOk,
      bookingPage: page.label,
      notes,
    };
  };

  const voiceMeta = sub.webVoiceMeta ?? null;
  const webVoiceNotes: string[] = [];
  if (sub.webVoiceEnabledByAgency !== true) webVoiceNotes.push("Web Voice (talking to the chat) is locked by the agency.");
  else if (!voiceMeta?.ready) webVoiceNotes.push("Web Voice isn't connected or needs attention (AI Agents → Web Chat → Voice card).");
  else if (!voiceMeta.enabled) webVoiceNotes.push("Web Voice is connected but the mic is switched off.");
  else webVoiceNotes.push("Web Voice is live, so visitors can also book by talking (same booking page).");

  // Ready only if at least one messaging channel is both unlocked and on.
  const messagingLive =
    (aiChannelGateOn(sub, "sms") && !!sms?.enabled) ||
    (aiChannelGateOn(sub, "whatsapp") && !!whatsapp?.enabled) ||
    (aiChannelGateOn(sub, "meta") && !!meta?.enabled);
  const messagingGate =
    aiChannelGateOn(sub, "sms") || aiChannelGateOn(sub, "whatsapp") || aiChannelGateOn(sub, "meta");
  const messagingPage = pageStatus(profile?.messagingBookingPageSlug);
  const messagingNotes: string[] = [];
  if (!messagingGate) messagingNotes.push("All messaging AI channels are locked by the agency.");
  messagingNotes.push(
    `Enabled: SMS ${sms?.enabled ? "on" : "off"}, WhatsApp ${whatsapp?.enabled ? "on" : "off"}, Messenger & Instagram ${meta?.enabled ? "on" : "off"} (each under its AI Agents tab).`,
  );
  if (messagingPage.note) messagingNotes.push(`${messagingPage.note} Set it under AI Agents → Overview → Live booking.`);

  const reports: ChannelReport[] = [
    channel("Web Chat (typed)", "web-chat", webChat?.enabled, webChat?.webChat?.bookingPageSlug, "AI Agents → Web Chat → Live appointment booking", webVoiceNotes),
    channel("Phone (inbound voice)", "voice", voice?.enabled, voice?.voice?.bookingPageSlug, "AI Agents → Voice → Live appointment booking", voice?.voice?.bookingPageSlug ? [
      voice?.voice?.allowCallerChanges === true
        ? "Callers can move or cancel their upcoming bookings."
        : "Callers can book but not move or cancel bookings. To allow it, tick 'Let callers move or cancel their upcoming bookings' under AI Agents → Voice (caller ID can be faked, so it's off by default).",
    ] : []),
    {
      channel: "SMS / WhatsApp / Messenger & Instagram",
      ready: messagingLive && messagingPage.ok && personaOk && aiOk,
      bookingPage: messagingPage.label,
      notes: messagingNotes,
    },
  ];

  const lines: string[] = [];
  lines.push(`AI LIVE BOOKING READINESS (this workspace only)`);
  lines.push(`Persona: ${personaOk ? "READY" : "NOT READY — save a persona prompt on AI Agents → Overview first; no channel replies without it."}`);
  lines.push(`AI replies (OpenRouter): ${aiOk ? "configured" : "NOT configured on this deployment — no AI channel can reply."}`);
  lines.push(`Confirmation emails: ${emailIsConfigured() ? "configured" : "NOT configured — bookings still land on the calendar but visitors get no confirmation email."}`);
  lines.push(`Reminders (QStash): ${qstashIsConfigured() ? "configured" : "NOT configured — no reminders will be sent."}`);
  lines.push(
    `Ask the booking page's questions before booking: ${profile?.bookingAskIntake === true ? "ON (every channel)" : "OFF"}.`,
  );
  lines.push("");
  for (const r of reports) {
    lines.push(`${r.channel}: ${r.ready ? "READY" : "NOT READY"}${r.bookingPage ? ` — books on ${r.bookingPage}` : ""}`);
    for (const n of r.notes) lines.push(`  - ${n}`);
  }
  lines.push("");
  lines.push(
    bookable.length > 0
      ? `Booking pages the AI can use (published, no deposit):\n${bookable
          .map((p) => `  - ${pageLabel(p)}${p.intakeFields.length > 0 ? ` — ${p.intakeFields.length} intake question(s)` : " — no intake questions"}${p.hosts?.length ? `, team of ${p.hosts.length}` : ""}`)
          .join("\n")}`
      : "No booking pages the AI can use yet. Offer to create one with create_booking_page (or the user can create and publish one, without a deposit, under Booking).",
  );
  lines.push(
    "Setting a channel's booking page also lets the AI move and cancel appointments there (messaging: any of that contact's upcoming bookings; web chat: only bookings made in that chat; phone: only when 'Let callers move or cancel their upcoming bookings' is ticked under AI Agents → Voice). Booking only happens while a conversation's AI is in auto mode.",
  );
  return lines.join("\n");
}

export interface ConfigureAiBookingInput {
  /** Slug, or null to switch booking off for that channel. Undefined = unchanged. */
  webChatPage?: string | null;
  voicePage?: string | null;
  messagingPage?: string | null;
  askIntake?: boolean;
}

/** Throws AiBookingSetupError with a user-facing reason when a page can't be used. */
async function requireBookablePage(subAccountId: string, slug: string): Promise<void> {
  const ctx = await getAgentBookingContext(subAccountId, slug);
  if (!ctx) {
    throw new AiBookingSetupError(
      `There's no booking page "${slug}" in this workspace. Run ai_booking_readiness to see the pages the AI can use.`,
    );
  }
  if (!ctx.bookable) {
    throw new AiBookingSetupError(
      ctx.reason === "page_requires_payment"
        ? `"${ctx.page.name}" takes a deposit, which the AI can't book. Pick another page.`
        : `"${ctx.page.name}" isn't published yet. Publish it under Booking, or pick another page.`,
    );
  }
}

/**
 * Same rules as the settings screens: a chosen page must exist in this
 * workspace, be published and take no deposit. Channels that were never set
 * up are refused rather than half-created. Everything is checked before
 * anything is written, and the writes land in one batch, so a confirmed
 * change applies fully or not at all.
 */
export async function configureAiBooking(
  subAccountId: string,
  input: ConfigureAiBookingInput,
): Promise<string[]> {
  const db = getAdminDb();
  const changes: string[] = [];

  for (const slug of [input.webChatPage, input.voicePage, input.messagingPage]) {
    if (slug) await requireBookablePage(subAccountId, slug);
  }
  if (input.webChatPage !== undefined) {
    const cfg = await getChannelConfig(subAccountId, "web-chat");
    if (!cfg?.webChat) {
      throw new AiBookingSetupError(
        "Web Chat hasn't been set up in this workspace yet. Save its settings once under AI Agents → Web Chat, then try again.",
      );
    }
  }
  if (input.voicePage !== undefined) {
    const cfg = await getChannelConfig(subAccountId, "voice");
    if (!cfg?.voice) {
      throw new AiBookingSetupError(
        "Phone (Voice) hasn't been set up in this workspace yet. Save its settings once under AI Agents → Voice, then try again.",
      );
    }
  }
  // Also runs the one-time legacy split before the profile doc is written.
  const existingProfile =
    input.messagingPage !== undefined || input.askIntake !== undefined
      ? await getAgentProfile(subAccountId)
      : null;

  const batch = db.batch();
  if (input.webChatPage !== undefined) {
    batch.update(db.doc(`subAccounts/${subAccountId}/aiAgent/web-chat`), {
      "webChat.bookingPageSlug": input.webChatPage,
      updatedAt: FieldValue.serverTimestamp(),
    });
    changes.push(input.webChatPage ? `Web Chat books on "${input.webChatPage}"` : "Web Chat booking off");
  }
  if (input.voicePage !== undefined) {
    // Booking runs in our LLM webhook, so the Vapi assistant needs no re-provisioning.
    batch.update(db.doc(`subAccounts/${subAccountId}/aiAgent/voice`), {
      "voice.bookingPageSlug": input.voicePage,
      // Switching booking off also drops caller changes, so a later page pick
      // doesn't quietly bring them back.
      ...(!input.voicePage ? { "voice.allowCallerChanges": false } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    });
    changes.push(input.voicePage ? `phone books on "${input.voicePage}"` : "phone booking off");
  }

  const profilePatch: Record<string, unknown> = {};
  if (input.messagingPage !== undefined) {
    profilePatch.messagingBookingPageSlug = input.messagingPage;
    changes.push(
      input.messagingPage
        ? `SMS/WhatsApp/Messenger book on "${input.messagingPage}"`
        : "messaging booking off",
    );
  }
  if (input.askIntake !== undefined) {
    profilePatch.bookingAskIntake = input.askIntake;
    changes.push(`booking questions ${input.askIntake ? "on" : "off"}`);
  }
  if (Object.keys(profilePatch).length > 0) {
    // Same seeding as upsertAgentProfile, inside the batch.
    const seed = existingProfile
      ? {}
      : { ...DEFAULT_AI_AGENT_PROFILE, createdAt: FieldValue.serverTimestamp() };
    batch.set(
      db.doc(`subAccounts/${subAccountId}/aiAgent/profile`),
      { ...seed, ...profilePatch, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
  }

  await batch.commit();
  return changes;
}
