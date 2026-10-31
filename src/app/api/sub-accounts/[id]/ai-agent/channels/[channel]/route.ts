import { NextResponse } from "next/server";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  getAgentProfile,
  getChannelConfig,
  upsertChannelConfig,
  type ConfiguredChannelId,
} from "@/lib/comms/ai/agent";
import type {
  AiChannelConfig,
  VoiceChannelConfig,
  WebChatChannelConfig,
  WhatsappChannelConfig,
} from "@/types/ai";
import {
  DEFAULT_VOICE_CONFIG,
  DEFAULT_WEB_CHAT_CONFIG,
  DEFAULT_WHATSAPP_CONFIG,
} from "@/types/ai";
import { subAccountWhatsappIsConfigured } from "@/lib/comms/twilio";
import { metaCanInbox } from "@/lib/comms/meta-capabilities";
import { emailInboxEnabled } from "@/lib/comms/email-inbox";
import { emailIsConfigured } from "@/lib/comms/resend";
import { qstashIsConfigured } from "@/lib/automations/qstash";
import { getAgentBookingContext } from "@/lib/server/agent-booking-service";
import {
  aiChannelGateOn,
  aiChannelLockedMessage,
} from "@/lib/comms/ai/gates";
import type { SubAccountDoc } from "@/types";
import {
  bindVapiAssistantToPhoneNumber,
  deleteVapiAssistant,
  deleteVapiPhoneNumber,
  ensureVapiAssistant,
  ensureVapiPhoneNumber,
  unbindVapiPhoneNumber,
  vapiIsConfigured,
  vapiPhoneNumberExists,
  VapiError,
} from "@/lib/comms/voice/vapi";

export const dynamic = "force-dynamic";

const VALID_CHANNELS: ConfiguredChannelId[] = [
  "sms",
  "web-chat",
  "voice",
  "whatsapp",
  "meta",
  "email",
];

/** Labels for the agency-gate 403 message. */
const CHANNEL_LABEL: Record<ConfiguredChannelId, string> = {
  sms: "SMS AI auto-reply",
  "web-chat": "Web Chat",
  voice: "Inbound Voice",
  whatsapp: "WhatsApp",
  meta: "Messenger & Instagram AI",
  email: "Email AI drafts",
};

function isValidChannel(v: string): v is ConfiguredChannelId {
  return (VALID_CHANNELS as string[]).includes(v);
}

/** Bare hostname from a URL or hostname; null for anything that isn't a
 *  domain, so typos don't silently land in the allowlist. */
function normaliseDomain(input: string): string | null {
  let s = input.trim().toLowerCase();
  if (!s) return null;
  if (s.includes("://")) {
    try {
      s = new URL(s).hostname;
    } catch {
      return null;
    }
  } else {
    s = s.replace(/^https?:\/\//, "").split("/")[0]!.split(":")[0]!;
  }
  // Needs a dot, or is "localhost".
  if (!s.includes(".") && s !== "localhost") return null;
  if (!/^[a-z0-9.-]+$/.test(s)) return null;
  return s;
}

function sanitiseVoiceBlock(raw: unknown): Partial<VoiceChannelConfig> {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: Partial<VoiceChannelConfig> = {};

  if ("greeting" in r && typeof r.greeting === "string") {
    out.greeting = r.greeting.trim().slice(0, 400);
  }
  if ("voiceProvider" in r && typeof r.voiceProvider === "string") {
    out.voiceProvider = r.voiceProvider.trim().slice(0, 40);
  }
  if ("voiceId" in r && typeof r.voiceId === "string") {
    out.voiceId = r.voiceId.trim().slice(0, 120);
  }
  // Null/empty resets to the provider/Vapi default.
  if ("voiceVersion" in r) {
    out.voiceVersion =
      typeof r.voiceVersion === "string" && r.voiceVersion.trim()
        ? r.voiceVersion.trim().slice(0, 80)
        : null;
  }
  if ("transcriberProvider" in r) {
    out.transcriberProvider =
      typeof r.transcriberProvider === "string" && r.transcriberProvider.trim()
        ? r.transcriberProvider.trim().slice(0, 40)
        : null;
  }
  if ("transcriberModel" in r) {
    out.transcriberModel =
      typeof r.transcriberModel === "string" && r.transcriberModel.trim()
        ? r.transcriberModel.trim().slice(0, 80)
        : null;
  }
  if ("maxCallSeconds" in r && typeof r.maxCallSeconds === "number") {
    out.maxCallSeconds = Math.max(60, Math.min(1800, Math.floor(r.maxCallSeconds)));
  }
  // Booking-page slug for voice booking (null = off). Only the shape is
  // checked here; existence/published/payment are checked at runtime so a
  // later page edit degrades gracefully.
  if ("bookingPageSlug" in r) {
    const raw = r.bookingPageSlug;
    if (raw === null || raw === "") {
      out.bookingPageSlug = null;
    } else if (typeof raw === "string" && /^[a-z0-9-]{1,80}$/.test(raw.trim())) {
      out.bookingPageSlug = raw.trim();
    }
  }
  if ("allowCallerChanges" in r && typeof r.allowCallerChanges === "boolean") {
    out.allowCallerChanges = r.allowCallerChanges;
  }
  // Clearing the page also clears caller changes so picking a page later never revives them.
  if (out.bookingPageSlug === null) out.allowCallerChanges = false;
  if (
    "numberMode" in r &&
    (r.numberMode === "twilio-byoc" || r.numberMode === "vapi-managed")
  ) {
    out.numberMode = r.numberMode;
  }
  // Server-managed in twilio-byoc mode, operator-pasted in vapi-managed mode.
  // Provisioning only honours it in vapi-managed mode.
  if ("vapiPhoneNumberId" in r) {
    const raw = r.vapiPhoneNumberId;
    if (raw === null || raw === "") {
      out.vapiPhoneNumberId = null;
    } else if (typeof raw === "string") {
      out.vapiPhoneNumberId = raw.trim().slice(0, 120);
    }
  }
  // vapiAssistantId is always server-managed (set by provisioning), never
  // taken from the body.

  // Outbound calling
  if ("outboundEnabled" in r && typeof r.outboundEnabled === "boolean") {
    out.outboundEnabled = r.outboundEnabled;
  }
  if ("outboundFirstMessage" in r && typeof r.outboundFirstMessage === "string") {
    out.outboundFirstMessage = r.outboundFirstMessage.trim().slice(0, 400);
  }
  if (
    "outboundSystemPrompt" in r &&
    typeof r.outboundSystemPrompt === "string"
  ) {
    out.outboundSystemPrompt = r.outboundSystemPrompt.slice(0, 6000);
  }
  if ("outboundWindow" in r) {
    const w = r.outboundWindow as Record<string, unknown> | null;
    if (w === null) {
      out.outboundWindow = null;
    } else if (w && typeof w === "object") {
      const startHour = Number(w.startHour);
      const endHour = Number(w.endHour);
      const timezone =
        typeof w.timezone === "string" ? w.timezone.trim().slice(0, 64) : "";
      if (
        Number.isFinite(startHour) &&
        Number.isFinite(endHour) &&
        startHour >= 0 &&
        endHour <= 24 &&
        startHour < endHour &&
        timezone
      ) {
        out.outboundWindow = {
          startHour: Math.floor(startHour),
          endHour: Math.floor(endHour),
          timezone,
        };
      }
    }
  }
  if ("outboundPerMinuteCap" in r && typeof r.outboundPerMinuteCap === "number") {
    out.outboundPerMinuteCap = Math.max(
      1,
      Math.min(60, Math.floor(r.outboundPerMinuteCap)),
    );
  }
  if ("outboundDailyCap" in r && typeof r.outboundDailyCap === "number") {
    out.outboundDailyCap = Math.max(
      1,
      Math.min(5000, Math.floor(r.outboundDailyCap)),
    );
  }
  if (
    "outboundPerNumberPerDay" in r &&
    typeof r.outboundPerNumberPerDay === "number"
  ) {
    out.outboundPerNumberPerDay = Math.max(
      1,
      Math.min(20, Math.floor(r.outboundPerNumberPerDay)),
    );
  }
  if ("allowedCountries" in r) {
    const ac = r.allowedCountries;
    if (ac === null) {
      out.allowedCountries = null;
    } else if (Array.isArray(ac)) {
      const codes = ac
        .filter((v): v is string => typeof v === "string")
        .map((v) => v.trim().toUpperCase())
        .filter((v) => /^[A-Z]{2}$/.test(v))
        .slice(0, 50);
      out.allowedCountries = codes.length > 0 ? codes : null;
    }
  }

  return out;
}

function sanitiseWebChatBlock(raw: unknown): Partial<WebChatChannelConfig> {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: Partial<WebChatChannelConfig> = {};

  if ("allowedDomains" in r && Array.isArray(r.allowedDomains)) {
    out.allowedDomains = (r.allowedDomains as unknown[])
      .filter((v): v is string => typeof v === "string")
      .map(normaliseDomain)
      .filter((s): s is string => !!s)
      .slice(0, 25);
  }
  if ("welcomeMessage" in r && typeof r.welcomeMessage === "string") {
    out.welcomeMessage = r.welcomeMessage.slice(0, 400);
  }
  if ("accentColor" in r && typeof r.accentColor === "string") {
    const v = r.accentColor.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(v)) out.accentColor = v.toLowerCase();
  }
  if (
    "position" in r &&
    (r.position === "right" || r.position === "left")
  ) {
    out.position = r.position;
  }
  // Shape only here. PATCH checks a newly chosen page is bookable, and every
  // turn re-checks so a later page edit degrades to the booking link.
  if ("bookingPageSlug" in r) {
    const raw = r.bookingPageSlug;
    if (raw === null || raw === "") {
      out.bookingPageSlug = null;
    } else if (typeof raw === "string" && /^[a-z0-9-]{1,80}$/.test(raw.trim())) {
      out.bookingPageSlug = raw.trim();
    }
  }

  return out;
}

function sanitiseWhatsappBlock(raw: unknown): Partial<WhatsappChannelConfig> {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: Partial<WhatsappChannelConfig> = {};
  if ("sessionWindowHours" in r && typeof r.sessionWindowHours === "number") {
    // Meta's standard window is 24h. A larger value wouldn't change Meta's
    // enforcement, only our pre-send guard, and would let the composer try
    // sends that get rejected.
    out.sessionWindowHours = Math.max(
      1,
      Math.min(24, Math.floor(r.sessionWindowHours)),
    );
  }
  return out;
}

/**
 * Per-channel AI Agent config (enabled, model, context size, escalation
 * overrides). One doc per channel. Admin-only. The persona lives on the
 * profile (ai-agent/profile); a channel can't be enabled without a prompt.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string; channel: string }> },
) {
  const { id, channel } = await ctx.params;
  if (!isValidChannel(channel)) {
    return NextResponse.json({ error: "Unknown channel" }, { status: 404 });
  }
  const auth = await requireSubAccountAdmin(request, id);
  if (auth instanceof NextResponse) return auth;

  const config = await getChannelConfig(id, channel);
  // Web Chat booking still works without these, but the settings card warns
  // that visitors won't get a confirmation email or reminders.
  const bookingReadiness =
    channel === "web-chat"
      ? {
          emailConfigured: emailIsConfigured(),
          remindersConfigured: qstashIsConfigured(),
        }
      : undefined;
  return NextResponse.json({ config, bookingReadiness });
}

function sanitisePatch(
  input: Record<string, unknown>,
): Partial<AiChannelConfig> {
  const patch: Partial<AiChannelConfig> = {};

  if ("enabled" in input && typeof input.enabled === "boolean") {
    patch.enabled = input.enabled;
  }
  if (
    "contextMessageCount" in input &&
    typeof input.contextMessageCount === "number"
  ) {
    patch.contextMessageCount = Math.max(
      1,
      Math.min(50, Math.floor(input.contextMessageCount)),
    );
  }
  if ("modelOverride" in input) {
    const raw = input.modelOverride;
    if (raw === null || raw === "") {
      patch.modelOverride = null;
    } else if (typeof raw === "string") {
      patch.modelOverride = raw.trim().slice(0, 100);
    }
  }
  if ("escalationKeywordsOverride" in input) {
    const raw = input.escalationKeywordsOverride;
    if (raw === null) {
      patch.escalationKeywordsOverride = null;
    } else if (Array.isArray(raw)) {
      patch.escalationKeywordsOverride = raw
        .filter((v): v is string => typeof v === "string")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .slice(0, 25);
    }
  }
  if ("escalationNotifyEmailOverride" in input) {
    const raw = input.escalationNotifyEmailOverride;
    if (raw === null || raw === "") {
      patch.escalationNotifyEmailOverride = null;
    } else if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
        patch.escalationNotifyEmailOverride = trimmed;
      }
    }
  }
  // Merged over the existing webChat object in PATCH so a partial update
  // (e.g. just welcomeMessage) keeps the other fields.
  if ("webChat" in input) {
    const block = sanitiseWebChatBlock(input.webChat);
    if (Object.keys(block).length > 0) {
      patch.webChat = block as WebChatChannelConfig;
    }
  }

  // Same merge as webChat. Vapi ids are stamped by provisioning;
  // sanitiseVoiceBlock strips them from the body.
  if ("voice" in input) {
    const block = sanitiseVoiceBlock(input.voice);
    if (Object.keys(block).length > 0) {
      patch.voice = block as VoiceChannelConfig;
    }
  }

  if ("whatsapp" in input) {
    const block = sanitiseWhatsappBlock(input.whatsapp);
    if (Object.keys(block).length > 0) {
      patch.whatsapp = block as WhatsappChannelConfig;
    }
  }

  return patch;
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string; channel: string }> },
) {
  const { id, channel } = await ctx.params;
  if (!isValidChannel(channel)) {
    return NextResponse.json({ error: "Unknown channel" }, { status: 404 });
  }
  const auth = await requireSubAccountAdmin(request, id);
  if (auth instanceof NextResponse) return auth;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const patch = sanitisePatch(body);
  if (Object.keys(patch).length === 0) {
    return NextResponse.json(
      { error: "No valid fields in patch" },
      { status: 400 },
    );
  }

  // No profile prompt means an empty persona; block it here so direct API
  // calls can't bypass the UI.
  if (patch.enabled === true) {
    const profile = await getAgentProfile(id);
    if (!profile || !profile.systemPrompt.trim()) {
      return NextResponse.json(
        {
          error:
            "Set the Agent persona on the Overview page before enabling this channel.",
        },
        { status: 400 },
      );
    }
  }

  // Every AI channel spends the agency's OpenRouter credits (voice also Vapi
  // minutes), so the agency must enable the channel for this sub-account
  // first. Same field the runtime webhooks read (lib/comms/ai/gates.ts).
  // Channel branches below add their own prerequisites.
  if (patch.enabled === true) {
    const saSnap = await getAdminDb().doc(`subAccounts/${id}`).get();
    const sa = saSnap.exists ? (saSnap.data() as SubAccountDoc) : null;
    if (!sa || !aiChannelGateOn(sa, channel)) {
      return NextResponse.json(
        { error: aiChannelLockedMessage(CHANNEL_LABEL[channel]) },
        { status: 403 },
      );
    }
  }

  // Merge with the existing block and seed defaults on first save so the doc
  // always has every field.
  if (channel === "web-chat" && patch.webChat) {
    const existing = await getChannelConfig(id, channel);
    const base: WebChatChannelConfig =
      existing?.webChat ?? { ...DEFAULT_WEB_CHAT_CONFIG };
    // Choosing a new booking page must point at one the assistant can book
    // on. An unchanged slug passes so a later page edit doesn't block saving
    // other settings (runtime falls back to the booking link then).
    const newSlug = patch.webChat.bookingPageSlug;
    if (newSlug && newSlug !== (base.bookingPageSlug ?? null)) {
      let bctx: Awaited<ReturnType<typeof getAgentBookingContext>>;
      try {
        bctx = await getAgentBookingContext(id, newSlug);
      } catch (err) {
        console.error(`[ai-agent/channels/web-chat] booking page check failed sa=${id}`, err);
        return NextResponse.json(
          { error: "Couldn't check that booking page. Try again." },
          { status: 500 },
        );
      }
      if (!bctx?.bookable) {
        return NextResponse.json(
          {
            error: !bctx
              ? "That booking page doesn't exist."
              : bctx.reason === "page_requires_payment"
                ? "Pages that take a deposit can't be booked in the chat. Pick another page."
                : "Publish that booking page before the assistant can book on it.",
          },
          { status: 400 },
        );
      }
    }
    patch.webChat = { ...base, ...patch.webChat };
  }

  // Merge like web-chat. Needs the agency WhatsApp gate and a configured
  // Twilio WhatsApp sender.
  if (channel === "whatsapp") {
    if (patch.whatsapp) {
      const existing = await getChannelConfig(id, channel);
      const base: WhatsappChannelConfig =
        existing?.whatsapp ?? { ...DEFAULT_WHATSAPP_CONFIG };
      patch.whatsapp = { ...base, ...patch.whatsapp };
    }
    if (patch.enabled === true) {
      const saSnap = await getAdminDb().doc(`subAccounts/${id}`).get();
      const sa = saSnap.exists ? (saSnap.data() as SubAccountDoc) : null;
      if (sa?.whatsappEnabledByAgency !== true) {
        return NextResponse.json(
          {
            error:
              "WhatsApp is disabled for this sub-account by your agency. Ask your agency owner to enable it.",
          },
          { status: 403 },
        );
      }
      if (!subAccountWhatsappIsConfigured(sa?.twilioConfig)) {
        return NextResponse.json(
          {
            error:
              "Add a WhatsApp sender number under Settings → SMS before enabling the WhatsApp channel. WhatsApp reuses your Twilio credentials.",
          },
          { status: 400 },
        );
      }
    }
  }

  // Messenger + Instagram. Needs the inbox gate and a connected Page.
  // Instagram scope is optional: a Messenger-only token still works (the
  // webhook skips IG without the scope).
  if (channel === "meta" && patch.enabled === true) {
    const saSnap = await getAdminDb().doc(`subAccounts/${id}`).get();
    const sa = saSnap.exists ? (saSnap.data() as SubAccountDoc) : null;
    if (sa?.metaInboxEnabledByAgency !== true) {
      return NextResponse.json(
        {
          error:
            "The Facebook & Instagram inbox is disabled for this sub-account by your agency — the AI can't reply to DMs that can't arrive. Ask your agency owner to enable the inbox first.",
        },
        { status: 403 },
      );
    }
    if (!metaCanInbox(sa.metaConfig)) {
      return NextResponse.json(
        {
          error:
            "Connect a Facebook Page under Settings → Facebook & Instagram before enabling the Messenger & Instagram AI.",
        },
        { status: 400 },
      );
    }
  }

  // Draft-only email AI reads replies from the two-way inbox, so it needs a
  // verified sending domain + the inbox opt-in. The agency gate is the
  // email-domain gate, checked above.
  if (channel === "email" && patch.enabled === true) {
    const saSnap = await getAdminDb().doc(`subAccounts/${id}`).get();
    const sa = saSnap.exists ? (saSnap.data() as SubAccountDoc) : null;
    if (!sa || !emailInboxEnabled(sa)) {
      return NextResponse.json(
        {
          error:
            "Enable the two-way email inbox first (Settings → Email sending domain, step 5) — the AI drafts replies to emails that arrive there.",
        },
        { status: 400 },
      );
    }
  }

  // Same merge as web-chat. Gates depend on numberMode: twilio-byoc needs a
  // Twilio number on this sub-account, vapi-managed needs a pasted Vapi
  // number id. Mode = patch, else existing, else "twilio-byoc".
  let subAccount: SubAccountDoc | null = null;
  if (channel === "voice") {
    const saSnap = await getAdminDb().doc(`subAccounts/${id}`).get();
    subAccount = saSnap.exists ? (saSnap.data() as SubAccountDoc) : null;

    const existingForGate = await getChannelConfig(id, channel);
    if (patch.voice) {
      const base: VoiceChannelConfig =
        existingForGate?.voice ?? { ...DEFAULT_VOICE_CONFIG };
      patch.voice = { ...base, ...patch.voice };
    }
    const resolvedVoice: VoiceChannelConfig =
      patch.voice ?? existingForGate?.voice ?? { ...DEFAULT_VOICE_CONFIG };

    // In BYOC mode we own the Vapi number resource. The client sends
    // `vapiPhoneNumberId: null` on every save, which would wipe the stored id
    // and make the next provisioning re-POST a number Vapi already has (400).
    // Keep the stored id while staying in BYOC; clear it only when switching
    // into BYOC so provisioning creates a fresh resource.
    if (patch.voice && resolvedVoice.numberMode === "twilio-byoc") {
      const previousMode = existingForGate?.voice?.numberMode ?? "twilio-byoc";
      patch.voice.vapiPhoneNumberId =
        previousMode === "twilio-byoc"
          ? (existingForGate?.voice?.vapiPhoneNumberId ?? null)
          : null;
    }

    // A Vapi number binds exactly one assistant; a second sub-account saving
    // the same number silently steals the line. Refuse a number another
    // sub-account in this agency holds, and check a newly pasted id exists
    // (assistant and number ids are both bare UUIDs, easy to mix up).
    const incomingNumberId =
      resolvedVoice.numberMode === "vapi-managed"
        ? resolvedVoice.vapiPhoneNumberId?.trim() || null
        : null;
    const numberChanged =
      incomingNumberId !== null &&
      incomingNumberId !== (existingForGate?.voice?.vapiPhoneNumberId ?? null);
    if (incomingNumberId && (numberChanged || patch.enabled === true)) {
      const agencyId = subAccount?.agencyId ?? "";
      const holder = agencyId
        ? await findVapiNumberHolder({
            agencyId,
            excludeSubAccountId: id,
            phoneNumberId: incomingNumberId,
          })
        : null;
      if (holder) {
        return NextResponse.json(
          {
            error: `That Vapi phone number is already used by "${holder}" in this agency. Saving would silently steal its line — use a different number.`,
          },
          { status: 409 },
        );
      }
    }
    if (numberChanged && incomingNumberId && vapiIsConfigured()) {
      const exists = await vapiPhoneNumberExists(incomingNumberId);
      if (!exists) {
        return NextResponse.json(
          {
            error:
              "Vapi has no phone number with that ID. Check you copied the phone number's ID (not an assistant ID) from Vapi → Phone Numbers.",
          },
          { status: 400 },
        );
      }
    }

    if (patch.enabled === true) {
      if (!vapiIsConfigured()) {
        return NextResponse.json(
          {
            error:
              "Vapi isn't configured on this deployment. Set VAPI_API_KEY and VAPI_WEBHOOK_SECRET in your environment, then try again.",
          },
          { status: 503 },
        );
      }
      if (resolvedVoice.numberMode === "twilio-byoc") {
        if (!subAccount?.twilioConfig?.enabled) {
          return NextResponse.json(
            {
              error:
                "Configure your dedicated Twilio number under Settings → SMS before enabling Voice in BYOC mode. Voice attaches to the same number.",
            },
            { status: 400 },
          );
        }
      } else if (resolvedVoice.numberMode === "vapi-managed") {
        if (!resolvedVoice.vapiPhoneNumberId) {
          return NextResponse.json(
            {
              error:
                "Paste your Vapi phone number ID before enabling Voice in vapi-managed mode. Find it under Vapi dashboard → Phone Numbers.",
            },
            { status: 400 },
          );
        }
      }
    }
  }

  await upsertChannelConfig(id, channel, patch);

  // Runs after the save so settings persist even if Vapi blips. Re-read
  // because the upsert may have just seeded voice defaults.
  if (channel === "voice" && subAccount) {
    const sideEffectError = await runVoiceProvisioningSideEffect({
      subAccountId: id,
      subAccount,
      enabled: patch.enabled,
    });
    if (sideEffectError) {
      // `enabled: true` claims the line is live, so roll back just that flag if
      // provisioning fails. Everything else stays saved.
      if (patch.enabled === true) {
        try {
          await upsertChannelConfig(id, channel, { enabled: false });
        } catch (rollbackErr) {
          console.error(
            `[ai-agent/channels/voice] enabled rollback failed sa=${id}`,
            rollbackErr,
          );
        }
      }
      return NextResponse.json({ error: sideEffectError }, { status: 502 });
    }
  }

  const updated = await getChannelConfig(id, channel);
  return NextResponse.json({ ok: true, config: updated });
}

/**
 * Name of another sub-account in this agency holding this Vapi number id,
 * or null. Fan-out over the agency's sub-accounts instead of a
 * collectionGroup query: no index needed, and it can't cross agencies.
 */
async function findVapiNumberHolder(opts: {
  agencyId: string;
  excludeSubAccountId: string;
  phoneNumberId: string;
}): Promise<string | null> {
  const db = getAdminDb();
  const subs = await db
    .collection("subAccounts")
    .where("agencyId", "==", opts.agencyId)
    .get();
  const others = subs.docs.filter((d) => d.id !== opts.excludeSubAccountId);
  if (others.length === 0) return null;
  const cfgSnaps = await db.getAll(
    ...others.map((d) => db.doc(`subAccounts/${d.id}/aiAgent/voice`)),
  );
  for (let i = 0; i < cfgSnaps.length; i++) {
    const voice = cfgSnaps[i].data()?.voice as
      | { vapiPhoneNumberId?: string | null }
      | undefined;
    if (voice?.vapiPhoneNumberId === opts.phoneNumberId) {
      return (others[i].data()?.name as string) || others[i].id;
    }
  }
  return null;
}

/**
 * Creates, updates or tears down the Vapi assistant + BYOC number for the
 * current voice state. Idempotent. Returns an error string on failure; the
 * caller turns it into a 502 (settings saved, Vapi not synced).
 */
async function runVoiceProvisioningSideEffect(input: {
  subAccountId: string;
  subAccount: SubAccountDoc;
  enabled: boolean | undefined;
}): Promise<string | null> {
  const { subAccountId, subAccount } = input;

  const current = await getChannelConfig(subAccountId, "voice");
  const voice: VoiceChannelConfig | null = current?.voice ?? null;
  const channelEnabled = current?.enabled === true;
  const mode = voice?.numberMode ?? "twilio-byoc";

  // Disabled: tear down so an idle config doesn't keep costing Vapi spend.
  // We only own the number in BYOC mode; in vapi-managed mode we unbind.
  if (!channelEnabled) {
    if (voice?.vapiPhoneNumberId) {
      if (mode === "twilio-byoc") {
        await deleteVapiPhoneNumber(voice.vapiPhoneNumberId);
      } else {
        await unbindVapiPhoneNumber(voice.vapiPhoneNumberId);
      }
    }
    if (voice?.vapiAssistantId)
      await deleteVapiAssistant(voice.vapiAssistantId);
    if (voice?.vapiPhoneNumberId || voice?.vapiAssistantId) {
      const cleared: VoiceChannelConfig = {
        ...(voice ?? DEFAULT_VOICE_CONFIG),
        vapiAssistantId: null,
        // Keep the pasted id in vapi-managed mode for re-enable; clear it in BYOC
        // (we just deleted it).
        vapiPhoneNumberId:
          mode === "vapi-managed" ? voice?.vapiPhoneNumberId ?? null : null,
      };
      await upsertChannelConfig(subAccountId, "voice", { voice: cleared });
    }
    return null;
  }

  // Re-read the profile so the latest persona/KB reaches the assistant.
  const profile = await getAgentProfile(subAccountId);
  if (!profile || !profile.systemPrompt.trim()) {
    return "Set the Agent persona on the Overview page before enabling Voice.";
  }
  if (!voice) {
    return "Voice config missing — try saving again.";
  }
  if (mode === "twilio-byoc" && !subAccount.twilioConfig?.enabled) {
    return "Dedicated Twilio number is required for voice in BYOC mode.";
  }
  if (mode === "vapi-managed" && !voice.vapiPhoneNumberId) {
    return "Vapi phone number ID is required for voice in vapi-managed mode.";
  }

  try {
    const { assistantId } = await ensureVapiAssistant({
      subAccountId,
      profile,
      voice,
      modelOverride: current?.modelOverride ?? null,
      existingAssistantId: voice.vapiAssistantId,
    });

    let phoneNumberId: string;
    if (mode === "twilio-byoc") {
      // BYOC: we own the resource.
      if (!subAccount.twilioConfig) {
        return "Dedicated Twilio config disappeared mid-save.";
      }
      const result = await ensureVapiPhoneNumber({
        subAccountId,
        twilioConfig: subAccount.twilioConfig,
        assistantId,
        existingPhoneNumberId: voice.vapiPhoneNumberId,
      });
      phoneNumberId = result.phoneNumberId;
    } else {
      // vapi-managed: just bind our assistant (id guaranteed by the gate above).
      const result = await bindVapiAssistantToPhoneNumber({
        phoneNumberId: voice.vapiPhoneNumberId!,
        assistantId,
      });
      phoneNumberId = result.phoneNumberId;
    }

    const stamped: VoiceChannelConfig = {
      ...voice,
      vapiAssistantId: assistantId,
      vapiPhoneNumberId: phoneNumberId,
    };
    await upsertChannelConfig(subAccountId, "voice", { voice: stamped });
    return null;
  } catch (err) {
    const detail =
      err instanceof VapiError
        ? `${err.message}${err.body ? `: ${err.body.slice(0, 200)}` : ""}`
        : err instanceof Error
          ? err.message
          : "Unknown error";
    console.error(
      `[ai-agent/channels/voice] Vapi provisioning failed sa=${subAccountId}: ${detail}`,
    );
    return `Vapi provisioning failed: ${detail}`;
  }
}
