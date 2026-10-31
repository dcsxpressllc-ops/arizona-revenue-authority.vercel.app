import type { StripeConnectionMeta } from "@/types/payments";
import type { Webinar1ConnectionMeta } from "@/types/webinar1";
import type { WebVoiceMeta } from "@/types/web-voice";

export type AgencyRole = "owner" | "staff";
export type SubAccountRole = "admin" | "collaborator";
export type SubAccountStatus = "active" | "archived";

/**
 * Dashboard accent theme; sets the --primary/--ring CSS vars via a class on
 * <html> (see globals.css, components/theme/app-accent.tsx). When unset:
 * "green" if LANDING_VARIANT is "custom", otherwise "neutral" so the demo
 * branding never changes on its own.
 */
export type AppTheme = "leadstack" | "green" | "neutral";

import type { Timestamp, FieldValue } from "firebase/firestore";
import type { SubscriptionStatus, MemberStatus } from "./firebase";

export interface AgencyDoc {
  id: string;
  name: string;
  ownerUid: string;
  createdAt: Date;
  updatedAt: Date;
  // Billing lives at agency scope.
  stripeCustomerId: string | null;
  subscriptionStatus: SubscriptionStatus;
  subscriptionPriceId: string | null;
  /** Public https logo URL, rendered as a plain <img>. Null = default LeadStack mark. */
  logoUrl: string | null;
  /** Shown on the custom landing. Null falls back to CUSTOM_BRAND.supportEmail. */
  supportEmail: string | null;
  /** No scheme, no trailing slash ("leadmachine.com"). Null falls back to CUSTOM_BRAND.primaryDomain. */
  primaryDomain: string | null;
  /** Null/undefined = mode default (see AppTheme). */
  appTheme?: AppTheme | null;
  /**
   * May sub-accounts fall back to the shared env-var Twilio sender for SMS?
   * undefined/true = allowed. false = each sub-account needs its own number.
   * Enforced in getTwilioForSubAccount.
   */
  sharedSmsAllowed?: boolean;
  /**
   * Agency Assistant master switch. Read `=== true` (off by default) because
   * every reply spends the deployment's OpenRouter credits. Separate from the
   * per-sub-account aiSuiteEnabledByAgency gate.
   */
  agencyAssistantEnabled?: boolean;
  /** Unset reads as "opus". */
  agencyAssistantModel?: AiSuiteModelChoice;
  /**
   * Usage rebilling master switch, read `=== true`. Off = no client is billed
   * for usage or flat fees, whatever their own switch says.
   */
  usageRebillingEnabled?: boolean;
  /** When the master switch last turned on (same rule as the client switch). */
  usageRebillingSince?: Date | null;
}

/**
 * Stored as a friendly key, not an OpenRouter slug, so the slug mapping lives
 * only in lib/ai-suite/model.ts. Unset reads as "opus" so upgrades keep the
 * model they had.
 */
export type AiSuiteModelChoice = "opus" | "sonnet";

export interface SubAccountDoc {
  id: string;
  agencyId: string;
  /**
   * Per-agency sequential label starting at 1000 (counter at
   * agencies/{agencyId}/counters/subAccount). UI only; URLs use the doc id.
   */
  accountNumber: number;
  name: string;
  slug: string;
  status: SubAccountStatus;
  timezone: string;
  /**
   * ISO-3166 alpha-2 fallback for phone numbers typed without a country code.
   * Unset reads as "US". "+"-prefixed numbers always parse as their own country.
   */
  defaultPhoneCountry?: string | null;
  /** Overrides the plan's quotas; null falls through to the plan, then unlimited. Agency owner only. */
  usageQuotas?: import("./usage").UsageQuotas | null;
  /** Same resolution as usageQuotas, for sell rates. */
  usageRates?: import("./usage").UsageRates | null;
  /** Bill this client for usage and flat fees. Needs AgencyDoc.usageRebillingEnabled too. Default off. */
  usageRebillingEnabled?: boolean;
  /** When the switch last turned on; a month is only billed if it was on before the month ended. */
  usageRebillingSince?: Date | null;
  /** Overrides the plan's spend ceiling (cents); null falls through to the plan. */
  usageSpendCapCents?: number | null;
  /** Overrides the plan's flat fees as a whole; null falls through, {} = no fees. */
  featureFees?: import("./usage").FeatureFees | null;
  /** Unpaid usage past its due date; drives the banner then the paywall. */
  usageOverdue?: UsageOverdue | null;
  createdByUid: string;
  createdAt: Date;
  updatedAt: Date;
  twilioConfig: TwilioConfig | null;
  /**
   * Browser dialer flags only. The Twilio API key/secret and TwiML App sid
   * live in subAccounts/{id}/private/dialer (Admin SDK only) because this
   * doc is member-readable. Undefined = disabled.
   */
  dialerConfig?: DialerConfig | null;
  /**
   * Dedicated sending domain on the agency's shared Resend account. Only
   * status "verified" sends from emailFrom; anything else falls back to the
   * deployment EMAIL_FROM. Unrelated to replyToEmail.
   */
  resendConfig: ResendConfig | null;

  // Agency feature gates. Only the agency owner flips these (PATCH
  // /api/agency/sub-accounts/[id]/feature-gates). Unless noted, they are
  // opt-in: read `=== true`, creation writes false, and disabling keeps data
  // so re-enabling resumes instantly. Off = routes 403 and the UI shows a
  // "Locked by your agency" state.

  /**
   * Off also tears down the Resend domain, and tenantFrom() short-circuits on
   * a falsy gate so sends fall back to EMAIL_FROM even if a verified config
   * lingers.
   */
  emailDomainEnabledByAgency?: boolean;
  /**
   * Off: every /api/v1/* request returns 403 api_access_disabled and no new
   * keys/webhooks can be minted. Existing keys and subscriptions are kept.
   */
  apiAccessEnabledByAgency?: boolean;
  /** Gated so a tenant can't blast 25k emails before the agency signs off. */
  broadcastsEnabledByAgency?: boolean;
  /**
   * Operator-initiated AI calls. Separate from inbound because it spends Vapi
   * minutes proactively and carries dialing-compliance risk. The assistant and
   * number are shared with inbound, so nothing is torn down.
   */
  outboundVoiceEnabledByAgency?: boolean;
  /** WhatsApp channel. Off also makes the inbound webhook ignore this sub-account. */
  whatsappEnabledByAgency?: boolean;
  /**
   * SMS AI auto-reply only; manual SMS sends are unaffected. DEFAULT ON:
   * the channel existed before the gate, so undefined reads as on (see
   * aiChannelGateOn) and upgrades don't silently kill a running bot. Only an
   * explicit false locks it. Creation writes true.
   */
  smsAgentEnabledByAgency?: boolean;
  /**
   * Web Chat widget bot. Default ON for the same reason as smsAgent. Off:
   * /api/web-chat/config returns {enabled:false} so the widget no-ops.
   */
  webChatEnabledByAgency?: boolean;
  /**
   * Inbound Vapi-answered calls. Default ON like smsAgent (outbound stays
   * opt-in). Off: the per-turn Vapi LLM webhook 403s.
   */
  inboundVoiceEnabledByAgency?: boolean;
  /**
   * Messenger + Instagram DM inbox (one Meta connection, so they flip
   * together). While off the feature is invisible everywhere: no webhook
   * handling, send route, settings or badges.
   */
  metaInboxEnabledByAgency?: boolean;
  /**
   * Messenger/IG AI auto-reply, layered on top of metaInboxEnabledByAgency
   * (inbox makes the DMs exist, this lets the AI answer). Checked via
   * lib/comms/ai/gates.ts at enable time and in the Meta webhook.
   */
  metaAgentEnabledByAgency?: boolean;
  /** "Send AI text" workflow step. Opt-in; only enabled while aiOutboundSmsReadiness() passes. */
  aiOutboundSmsEnabledByAgency?: boolean;
  /** Website builder. Agency-controlled because builds share the 30/hour gitpage quota. */
  websiteEnabledByAgency?: boolean;
  /**
   * Social Planner. Posts through the same metaConfig connection as the inbox,
   * plus publish scopes requested at connect time.
   */
  socialPlannerEnabledByAgency?: boolean;
  /** Get Leads (Outscraper prospecting). Every search spends the agency's Outscraper credits. */
  getLeadsEnabledByAgency?: boolean;
  /**
   * Custom business types for the Get Leads picker. Each label is also the
   * Maps query (<=60 chars, <=30 entries). Part of the search allowlist.
   */
  getLeadsCustomTypes?: string[];
  /** Curated types hidden from the picker. Presentation only; search still accepts them. */
  getLeadsHiddenTypes?: string[];
  /** Community + Courses. Off also 404s/403s every public /c/* page and API. */
  communityEnabledByAgency?: boolean;
  /**
   * Missed Call Text Back (forward the call, text the caller on a miss). The
   * sub-account's own disable restores the number's previous Voice URL.
   */
  missedCallTextBackEnabledByAgency?: boolean;
  /**
   * Labs (pre-release features, currently Quick Funnels). Each experiment
   * keeps its own runtime gates on top.
   */
  labsEnabledByAgency?: boolean;
  /**
   * Agent monitors (AI Agents → Monitors): background agents that flag
   * unanswered threads and stalled deals. Opt-in because every judgment
   * spends the agency's AI credits.
   */
  agentsEnabledByAgency?: boolean;
  /**
   * Sub-account connects its OWN Stripe to charge its own customers. Gated
   * because a connected key moves real money, not because it costs the agency
   * anything. A disconnect is always an explicit operator action. Not the
   * same as `billing`, which is the agency charging this sub-account.
   */
  paymentsEnabledByAgency?: boolean;
  /**
   * Products can be sold from the website and an express buy link. Also needs
   * the Payments gate and a ready Stripe connection. Controls selling only:
   * an order already paid is always fulfilled.
   */
  sellOnlineEnabledByAgency?: boolean;
  /**
   * Display metadata only. The restricted key lives in
   * subAccounts/{id}/private/stripeConnection: this doc is member-readable and
   * rules can't hide a single field. Never add a credential here.
   */
  stripeConnectionMeta?: StripeConnectionMeta | null;
  /**
   * Display metadata only; API key and webhook secret live in
   * private/webinar1Connection. Never add a credential here.
   */
  webinar1ConnectionMeta?: Webinar1ConnectionMeta | null;
  /**
   * Webinar1 integration (sidebar, settings card, /webinar1/* routes). Not in
   * PLAN_GATE_KEYS: an external connection is an explicit per-client choice.
   */
  webinar1EnabledByAgency?: boolean;
  /**
   * Visitors talk to the web-chat bot on the client's own ElevenLabs key.
   * Layered on the Web Chat gate; gated because each turn still spends the
   * agency's OpenRouter tokens.
   */
  webVoiceEnabledByAgency?: boolean;
  /** Display metadata only; the key lives in private/webVoiceConnection. */
  webVoiceMeta?: WebVoiceMeta | null;
  /** Slack notifications; the Incoming Webhook URL lives in private/slack. */
  slackMeta?: import("./slack").SlackMeta | null;
  /**
   * Workspace Assistant. Spends the agency's OpenRouter credits. The
   * agency-level assistant has its own switch (AgencyDoc.agencyAssistantEnabled).
   */
  aiSuiteEnabledByAgency?: boolean;
  /** Unset reads as "opus" (normalizeAiSuiteModelChoice). Only matters while aiSuiteEnabledByAgency is on. */
  aiSuiteModel?: AiSuiteModelChoice;
  /**
   * Sidebar behaviour for a feature whose gate is off. Read `!== false`:
   * unset/true hides the entry entirely, false shows a greyed "Locked" entry
   * (upsell). No effect while the feature is enabled.
   */
  broadcastsHiddenWhenDisabled?: boolean;
  websiteHiddenWhenDisabled?: boolean;
  socialPlannerHiddenWhenDisabled?: boolean;
  communityHiddenWhenDisabled?: boolean;
  getLeadsHiddenWhenDisabled?: boolean;
  aiSuiteHiddenWhenDisabled?: boolean;
  labsHiddenWhenDisabled?: boolean;
  agentsHiddenWhenDisabled?: boolean;
  paymentsHiddenWhenDisabled?: boolean;
  webinar1HiddenWhenDisabled?: boolean;
  /** Null until an admin connects a Page (requires metaInboxEnabledByAgency). */
  metaConfig?: MetaConfig | null;
  bookingConfig: BookingConfig | null;
  sendWindow: SendWindow | null;
  /** Resolves {{bookingLink}}. Any URL (Calendly, Cal.com, etc.). Null = empty string. */
  bookingLink: string | null;
  /** Admin switch letting members show their Google events on the CRM calendar. Absent = off. */
  calendarImportAllowed?: boolean;
  /** Bumped by every flip of calendarImportAllowed, so running syncs back off. */
  calendarImportGeneration?: number;
  /**
   * Reply-To for every email sent for this sub-account (workflow and manual).
   * One address on purpose so client replies land in one inbox. Null = none.
   */
  replyToEmail: string | null;
  /**
   * Kill switch: fireTriggers() returns early and in-flight runs stop at the
   * next step with skippedReason "automation_disabled". Driven by "Pause all
   * workflows" in Settings -> Sending preferences.
   */
  automationsPaused: boolean;
  /** Main contact at the client. Null for internal-team sub-accounts. */
  accountContact: AccountContact | null;
  /**
   * PayPal.me username for invoice Pay links
   * (https://paypal.me/{username}/{amount}{currency}). Null = not connected.
   */
  paypalConfig: PayPalConfig | null;
  /** Undefined reads as off. */
  googleReviewConfig?: GoogleReviewConfig | null;
  /**
   * Client brand logo on customer-facing surfaces (quote/invoice emails,
   * /q/[token], PDFs). agency.logoUrl is the internal CRM chrome. Null = name only.
   */
  logoUrl: string | null;
  /**
   * Opt-in: collaborators only see deals/contacts whose territoryId is in
   * their assignedTerritoryIds. Admins and the agency owner are unaffected.
   * Read `=== true`; when off, territory data is kept but ignored.
   */
  territoryScopingEnabled?: boolean;
  territoryScopingEnabledAt?: Date | null;
  territoryScopingEnabledByUid?: string | null;
  /**
   * Label/order overrides for the default pipeline's stages. Display only:
   * ids and won/lost terminals always come from the canonical set. Absent =
   * canonical stages unchanged. Ignored once a pipelines/default doc exists.
   */
  pipelineStages?: import("./deals").PipelineStageOverride[];
  /** GHL import connection. Token is a server-only secret, like twilioConfig.authToken. */
  ghlImportConfig?: GhlImportConfig | null;
  /**
   * Agency charging this sub-account on the deployment's Stripe. Absent/null =
   * comped (no charge, no paywall). Server writes only.
   */
  billing?: import("./billing").SubAccountBilling | null;
}

export interface GhlImportConfig {
  /** GHL Private Integration Token (pit-...). Never sent to the browser. */
  token: string;
  /** GHL location id the token is scoped to. */
  locationId: string;
  connectedByUid: string | null;
  connectedAt: Timestamp | FieldValue | null;
  lastValidatedAt: Timestamp | FieldValue | null;
}

/** Oldest overdue usage charge. Member-readable on purpose: it drives the paywall. */
export interface UsageOverdue {
  chargeId: string;
  /** The charge's due date. */
  since: Timestamp | Date | null;
  amountCents: number;
  currency: string;
  /** "YYYY-MM" the charge covers. */
  usageMonth: string | null;
}

export interface AccountContact {
  name: string | null;
  email: string | null;
  phone: string | null;
}

export interface TwilioConfig {
  /**
   * Dedicated-SMS switch. true = use these creds and show the Messages tab.
   * false (or null config) = shared env-var Twilio.
   */
  enabled: boolean;
  accountSid: string;
  authToken: string;
  /** E.164, e.g. "+15551234567". */
  fromNumber: string;
  /**
   * E.164 WhatsApp sender WITHOUT the "whatsapp:" prefix (added at send time).
   * Reuses the SMS creds. Null = WhatsApp not configured.
   */
  whatsappFromNumber?: string | null;
  /** Sender is Twilio's shared sandbox: inbound only works for numbers that joined it. */
  whatsappSandbox?: boolean;
  /** false/undefined = auto-config failed or wasn't tried; operator sets it in Twilio. */
  whatsappInboundWebhookConfigured?: boolean;
  /** false = setting smsUrl via IncomingPhoneNumbers failed; operator configures manually. */
  inboundWebhookConfigured: boolean;
  /** Last successful /Accounts/{sid} check with these creds. */
  lastValidatedAt: Date | null;
  /** Unused (null). Inbound is verified with Twilio's signature using authToken. */
  inboundWebhookSecret: string | null;
  /**
   * Missed Call Text Back: the number's Voice URL points at
   * /api/webhooks/twilio/voice, which forwards to forwardTo and texts the
   * caller on a miss. Mutually exclusive with the inbound Voice AI channel
   * (which owns the Voice URL via Vapi). Null/undefined = off.
   */
  missedCall?: MissedCallConfig | null;
}

export interface MissedCallConfig {
  enabled: boolean;
  /** E.164 number to ring first. Required to enable. */
  forwardTo: string;
  /** Seconds to ring forwardTo before counting it as missed (5-60). */
  ringTimeoutSec: number;
  /** Supports template {{merge}} tags, resolved against the caller's contact. */
  messageBody: string;
  /** Voice URL from before MCTB took over, restored on disable. Usually null. */
  prevVoiceUrl: string | null;
  voiceWebhookConfigured: boolean;
}

/**
 * Messenger + Instagram DM connection (one Page, one token), written by
 * /api/meta/callback. Only touched while metaInboxEnabledByAgency is on.
 */
export interface MetaConfig {
  /** Page connected and webhook subscription attempted. */
  connected: boolean;
  /** Messenger events are routed by this. */
  pageId: string;
  pageName: string;
  /** Long-lived Page token. Stored like TwilioConfig.authToken; never shown back. */
  pageAccessToken: string;
  /** IG events are routed by this. Null if the Page has no IG account. */
  instagramBusinessAccountId: string | null;
  instagramUsername: string | null;
  /**
   * What the stored token can do: permissions Meta actually granted
   * (/me/permissions) intersected with the gates on at connect time.
   * inbox = pages_messaging, instagramDm = instagram_manage_messages,
   * publish = pages_manage_posts. instagramDm is separate because a user can
   * decline the IG scope and still grant pages_messaging. Missing on legacy connections: inbox reads true,
   * instagramDm falls back to inbox, publish reads false (reconnect to post).
   */
  capabilities?: { inbox: boolean; publish: boolean; instagramDm?: boolean };
  connectedByUid: string | null;
  connectedAt: Timestamp | FieldValue | null;
}

export interface PayPalConfig {
  /** Bare PayPal.me username (1-20 chars, alnum + hyphens), no "paypal.me/" prefix. */
  username: string;
  connectedAt: Date;
}

/**
 * Review requests sent by lib/reviews/request.ts after a quote/invoice is
 * paid, or on demand from the contact profile.
 */
export interface GoogleReviewConfig {
  /** Gates the auto trigger only. The manual button works whenever reviewUrl is set. */
  enabled: boolean;
  /** e.g. https://g.page/r/<id>/review */
  reviewUrl: string;
  /** Legacy docs may store "whatsapp"; normalize via normalizeReviewChannel. */
  channel: "sms" | "whatsapp_template" | "whatsapp_manual";
  /** SMS + whatsapp_manual body. Tags: {{firstName}} {{businessName}} {{reviewUrl}}. */
  messageTemplate: string;
  /** APPROVED whatsappTemplates doc id, for whatsapp_template only. */
  whatsappTemplateId: string | null;
  /** Skip an auto re-ask within this many days. */
  cooldownDays: number;
  triggerOnQuotePaid: boolean;
  /**
   * Auto-send when a Won deal is ticked Completed. SMS / WhatsApp Template
   * only (manual WhatsApp can't auto-send). Undefined = off.
   */
  triggerOnDealCompleted?: boolean;
  updatedAt: Date;
}

/** Client-visible dialer flags. Secrets are in DialerPrivateDoc. */
export interface DialerConfig {
  enabled: boolean;
  /** Default false; recording-consent laws vary by region. */
  recordCalls: boolean;
}

/**
 * subAccounts/{id}/private/dialer. Covered by the private/{docId} deny rule;
 * written only by the dialer provisioning route.
 */
export interface DialerPrivateDoc {
  /** API Key SID (SK...) on the sub-account's own Twilio account. */
  apiKeySid: string;
  /** Twilio only returns this once, at creation. */
  apiKeySecret: string;
  /** TwiML App (AP...) whose voice URL is our dialer TwiML webhook. */
  twimlAppSid: string;
  createdAt: Date;
}

export interface ResendConfig {
  /** Resend Domains API id. */
  domainId: string;
  /** e.g. "mail.acmeplumbing.com" */
  domainName: string;
  /** e.g. "Acme Plumbing <hello@mail.acmeplumbing.com>" */
  emailFrom: string;
  /** Only "verified" sends live; anything else falls back to the shared EMAIL_FROM. */
  status: "pending" | "verified" | "failed";
  lastValidatedAt: Date | null;
  /**
   * Two-way email inbox (opt-in). Outbound Reply-To becomes
   * replies+<contactId>@<domainName> so replies come back via the
   * email.received webhook. Needs a verified domain plus receiving enabled
   * and the MX record in place.
   */
  inboxEnabled?: boolean;
  /**
   * Open + click tracking on the Resend domain (opt-in; click tracking
   * rewrites links through the provider's tracking host). Off = broadcast
   * opens/clicks stay at zero; delivered/bounced still report.
   */
  trackingEnabled?: boolean;
}

export interface BookingConfig {
  defaultPageSlug: string;
  types: Array<{ slug: string; label: string; durationMinutes: number }>;
}

export interface SendWindow {
  startHour: number;
  endHour: number;
  timezone: string;
}

export interface AgencyMemberDoc {
  uid: string;
  agencyId: string;
  role: AgencyRole;
  status: MemberStatus;
  email: string;
  displayName: string;
  addedAt: Date;
  addedByUid: string;
}

export interface SubAccountMemberDoc {
  uid: string;
  subAccountId: string;
  agencyId: string;
  role: SubAccountRole;
  status: MemberStatus;
  email: string;
  displayName: string;
  addedAt: Date;
  addedByUid: string;
  /**
   * Empty/undefined = no territory access. Ignored for admins or when the
   * sub-account's territoryScopingEnabled isn't true.
   */
  assignedTerritoryIds?: string[];
}

export type TerritoryStatus = "active" | "archived";

/**
 * Fixed id of the auto-seeded "Global" territory
 * (subAccounts/{saId}/territories/global). Contacts and members default to
 * it, so turning scoping on doesn't blank anyone's pipeline.
 */
export const GLOBAL_TERRITORY_ID = "global";

/** subAccounts/{saId}/territories/{territoryId}, admin-managed. */
export interface TerritoryDoc {
  id: string;
  subAccountId: string;
  agencyId: string;
  /** 1-60 chars, unique per sub-account (case-insensitive). */
  name: string;
  /** Optional 1-12 chars, e.g. "CA", "DACH". */
  code: string | null;
  status: TerritoryStatus;
  createdByUid: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface InviteDocV2 {
  id: string;
  email: string;
  agencyId: string;
  subAccountId: string | null;
  subAccountRole: SubAccountRole | null;
  agencyRole: AgencyRole | null;
  invitedByUid: string;
  createdAt: Date;
  acceptedByUid: string | null;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  /**
   * Copied to the member's assignedTerritoryIds on signup; empty = Global.
   * Collaborator invites only; admins see every territory.
   */
  assignedTerritoryIds?: string[];
}

export interface UserSubAccountMembership {
  subAccountId: string;
  agencyId: string;
  role: SubAccountRole;
  name: string;
  /** Mirror of SubAccountDoc.accountNumber. Missing on older sub-accounts. */
  accountNumber?: number;
  addedAt: Date;
}

export interface UserAgencyMembership {
  agencyId: string;
  role: AgencyRole;
  name: string;
}

export interface TenantScope {
  agencyId: string;
  subAccountId: string;
}
