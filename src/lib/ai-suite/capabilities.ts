import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { metaAppConfigured } from "@/lib/comms/meta";
import { GET_LEADS_PARKED } from "@/lib/get-leads/business-types";
import { generateSigningSecret } from "@/lib/api/webhooks/signing";
import {
  createSubscription,
  getSubscription,
  listSubscriptions,
  updateSubscription,
} from "@/lib/firestore/webhook-subscriptions";
import { sendDirectTestDelivery } from "@/lib/webhooks/direct-test";
import {
  detectAutomationUrl,
  n8nProductionUrl,
  validateWebhookUrl,
} from "@/lib/webhooks/validate-url";
import {
  categoryOf,
  eventsAreSingleCategory,
} from "@/lib/webhooks/event-categories";
import { WEBHOOK_EVENT_TYPES, type WebhookEventType } from "@/types/webhooks";
import { createSubAccountForAgency } from "@/lib/server/sub-accounts-service";
import {
  assignPlanToSubAccount,
  BillingError,
  compSubAccount,
  createOneTimeCharge,
  createPlanForAgency,
  listChargesForSubAccount,
  listPlansForAgency,
  mintCheckoutLink,
} from "@/lib/server/billing-service";
import {
  FEE_GATE_KEYS,
  feeGateOn,
  PLAN_GATE_KEYS,
  type BillingInterval,
  type FeeGateKey,
  type PlanGateKey,
  type PlanGates,
  type SubAccountBilling,
} from "@/types/billing";
import {
  createInviteServerSide,
  MemberAddBlockedError,
} from "@/lib/server/members-service";
import {
  createGroupServerSide,
  getGroupById,
} from "@/lib/server/community-service";
import {
  createCourseServerSide,
  createLessonServerSide,
  createSectionServerSide,
  getCourseTree,
  updateLessonServerSide,
} from "@/lib/server/community-classroom-service";
import {
  createContactServerSide,
  updateContactServerSide,
} from "@/lib/server/contacts-service";
import {
  createPipeline,
  loadResolvedPipelines,
  PipelineError,
} from "@/lib/server/pipelines-service";
import {
  computeFeatureFees,
  computeOverage,
  getEffectiveBilling,
  invalidateUsageBillingCache,
  sanitizeUsageQuotas,
  stampFeaturesOn,
  usageMonthKey,
} from "@/lib/server/usage-meter";
import type { UsageMonthDoc, UsageQuotas } from "@/types/usage";
import {
  getStaleDealsConfig,
  getWatchdogConfig,
  listAgentRuns,
  listWatchdogRuns,
  upsertStaleDealsConfig,
  upsertWatchdogConfig,
} from "@/lib/server/agents-watchdog-service";
import type { WatchdogQuietHours } from "@/types/custom-agents";
import {
  SlackError,
  connectSlack,
  getSlackConfig,
  sanitizeSlackEvents,
  updateSlackEvents,
} from "@/lib/server/slack-service";
import { DEFAULT_SLACK_EVENTS } from "@/types/slack";
import type { AiSuiteSecretInput } from "@/types/ai-suite";
import { invalidateSlackHookCache } from "@/lib/slack/events";
import {
  GROUPS as SETUP_GROUPS,
  evaluateGroup as evaluateSetupGroup,
} from "@/lib/setup/catalog";
import { LANDING_VARIANT } from "@/config/landing";
import { applySnapshot } from "@/lib/snapshots/apply";
import type { SnapshotPayload } from "@/types/snapshots";
import { markQuotePaidServerSide } from "@/lib/server/quotes-service";
import { markBookingPaidServerSide } from "@/lib/server/bookings-service";
import { computeQuoteTotals, effectiveQuoteStatus } from "@/lib/quotes/calc";
import type { Quote } from "@/types/quotes";
import type { CalendarEvent } from "@/types/events";
import { effectiveBillingState } from "@/lib/billing/status";
import {
  createDealServerSide,
  updateDealServerSide,
} from "@/lib/server/deals-service";
import {
  createTaskServerSide,
  setTaskCompletedServerSide,
} from "@/lib/server/tasks-service";
import { createEventServerSide } from "@/lib/server/events-service";
import { utcFromWallClock } from "@/lib/booking/availability";
import {
  getStage,
  PIPELINE_STAGES,
  type DealPriority,
  type PipelineStageId,
} from "@/types/deals";
import {
  aiSmsActivationBlock,
  createWorkflowServerSide,
  getWorkflow,
  listWorkflows,
  updateWorkflowServerSide,
  type WorkflowTemplate,
} from "@/lib/server/workflows-service";
import {
  createWebsiteForSubAccount,
  submitWebsiteBuildForSubAccount,
  updateWebsiteCtaAndRebuild,
  WebsiteServiceError,
} from "@/lib/server/websites-service";
import {
  createFormServerSide,
  formEmbedSnippet,
  formPublicUrl,
  FormServiceError,
  getFormForSubAccount,
  listFormsForSubAccount,
} from "@/lib/server/forms-service";
import { enrollForTest } from "@/lib/workflows/engine";
import { validateEmailBody } from "@/lib/automations/merge-tags";
import { qstashIsConfigured } from "@/lib/automations/qstash";
import { emailIsConfigured } from "@/lib/comms/resend";
import {
  smsIsConfigured,
  subAccountTwilioIsConfigured,
  subAccountWhatsappIsConfigured,
} from "@/lib/comms/twilio";
import type { WorkflowNode, WorkflowReentry } from "@/types/workflows";
import type { TwilioConfig } from "@/types/tenancy";
import { pushIsConfigured } from "@/lib/push/config";
import { fetchConcepts, gitpageIsConfigured, GitpageError } from "@/lib/gitpage/client";
import { validatePremiumDetails } from "@/lib/website/premium";
import { isNicheKey } from "@/lib/website/niches";
import { MAX_WEBSITES_PER_SUBACCOUNT } from "@/lib/website/limits";
import {
  FirecrawlError,
  firecrawlIsConfigured,
  scrapeUrl,
} from "@/lib/firecrawl/client";
import {
  GITPAGE_COLOR_SCHEMES,
  GITPAGE_DESIGN_BUTTONS,
  GITPAGE_DESIGN_COLOR_PALETTES,
  GITPAGE_DESIGN_COMPONENTS,
  GITPAGE_DESIGN_CONTACT_FORM,
  GITPAGE_DESIGN_ICONS,
  GITPAGE_DESIGN_INTERACTIONS,
  GITPAGE_DESIGN_LAYOUT,
  GITPAGE_DESIGN_TYPOGRAPHY,
  GITPAGE_LANGUAGES,
} from "@/lib/website/gitpage-values";
import {
  blankBusinessDetails,
  blankPremiumDetails,
  blankVslConfig,
  blankWebsiteConfig,
  effectiveQuality,
  type Niche,
  type WebsiteConfig,
  type WebsitePremiumDetails,
  type WebsiteProvisioning,
} from "@/types/website";
import type { AiSuiteLevel } from "@/types/ai-suite";
import {
  AiBookingSetupError,
  configureAiBooking,
  getAiBookingReadiness,
} from "@/lib/server/ai-booking-setup-service";
import { createBookingPageForSubAccount } from "@/lib/server/booking-pages-service";
import { defaultBookingPageFormData } from "@/lib/booking/defaults";
import {
  validateBookingLocation,
  validateMeetingUrl,
  validateTimezone,
} from "@/lib/booking/validation";
import { describeBookingLocation } from "@/lib/booking/location";

/**
 * The AI Suite capability registry: everything the assistant can do. The model
 * can only invoke a capability named here, each one wraps an existing guarded
 * write path, and the confirm endpoint re-checks permission and re-validates
 * args before `execute` runs.
 *
 * Writes (default) are proposals the user must confirm. Lookups
 * (`readonly: true`) run immediately in the chat route and feed the result
 * back to the model (answering state questions, resolving names to ids). A
 * lookup must never mutate anything.
 *
 * Adding a capability = one entry here (schema, validate, summarize, execute)
 * plus its required role. Nothing else grants the agent power.
 */

/**
 * Execute-time failure whose message is safe to show verbatim (gate off,
 * record from another tenant...). Any other thrown error stays a generic
 * "the action failed".
 */
export class CapabilityUserError extends Error {}

/** Enforced server-side in the confirm route. */
export type RequiredRole =
  | "agencyOwner"
  | "subAccountAdmin"
  | "subAccountMember";

/**
 * Resolved from the authenticated caller, never from model output, so the
 * model can't target another tenant.
 */
export interface AiSuiteActionContext {
  uid: string;
  email: string;
  displayName: string;
  agencyId: string;
  subAccountId?: string;
  subAccountRole?: string;
  /** Set when the Agency Assistant runs a capability inside a client workspace. */
  delegatedFromAgency?: boolean;
}

export interface ExecuteResult {
  /** Confirmation appended to the chat; for lookups, the tool result fed back to the model. */
  resultText: string;
  /** Created resource, for the audit trail. */
  ref?: { kind: string; id: string };
  /**
   * Lookup-only: same-origin "Open ..." button target. The chat route then
   * shows `resultText` directly. Built server-side from the caller's own
   * memberships, never from a model-composed URL.
   */
  navigate?: { href: string; label: string };
}

type ValidateResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: string };

export interface AiSuiteCapability {
  name: string;
  level: AiSuiteLevel;
  requiredRole: RequiredRole;
  /** Runs immediately with no confirm card. Must not mutate. Absent/false = confirm-gated write. */
  readonly?: boolean;
  /** Plain-language line for "what can you do?" answers. */
  menuLabel: string;
  /** Tool description shown to the model. */
  description: string;
  /** JSON Schema (OpenAI/OpenRouter shape). */
  parameters: Record<string, unknown>;
  /** Runs before proposing and again before executing; model output is never trusted. */
  validate: (raw: unknown) => ValidateResult;
  /** One-line summary for the confirm card. */
  summarize: (args: Record<string, unknown>) => string;
  /**
   * Values the confirm card collects and sends only to the confirm route
   * (keys, webhook URLs). Absent from the tool schema so the model never asks
   * for them; stripped from the audit row.
   */
  secretInputs?: AiSuiteSecretInput[];
  /** Runs the action via an existing service. */
  execute: (
    ctx: AiSuiteActionContext,
    args: Record<string, unknown>
  ) => Promise<ExecuteResult>;
}

// Validation helpers
const SLUG_RE = /^[a-z0-9-]+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function str(raw: unknown, key: string): string {
  const v = (raw as Record<string, unknown>)?.[key];
  return typeof v === "string" ? v.trim() : "";
}

/** Trimmed, de-duplicated, non-empty strings. */
function strList(raw: unknown, key: string, max = 20): string[] {
  const v = (raw as Record<string, unknown>)?.[key];
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string") continue;
    const t = item.trim();
    if (t && !out.some((o) => o.toLowerCase() === t.toLowerCase())) {
      out.push(t);
    }
  }
  return out.slice(0, max);
}

/** Number or numeric string to a finite number, else null. */
function num(raw: unknown, key: string): number | null {
  const v = (raw as Record<string, unknown>)?.[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return null;
}

/** Accepts "true"/"false" strings too. */
function bool(raw: unknown, key: string): boolean | null {
  const v = (raw as Record<string, unknown>)?.[key];
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return null;
}

function fmtCents(cents: number, currency: string): string {
  return `${currency.toUpperCase()} ${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Escape model/user text before it goes into bodyHtml. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Plain text to minimal safe HTML (paragraphs on blank lines). */
function textToBodyHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p.trim()).replace(/\n/g, "<br/>")}</p>`)
    .join("");
}

const STAGE_IDS = PIPELINE_STAGES.map((s) => s.id);

function fmtMoney(value: number, currency: string): string {
  return `${currency} ${value.toLocaleString("en-US")}`;
}

const TIME_24H_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

/** IANA timezone, falling back to UTC. */
async function subAccountTimezone(subAccountId: string): Promise<string> {
  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  const tz = snap.data()?.timezone;
  return typeof tz === "string" && tz ? tz : "UTC";
}

/** YYYY-MM-DD in a timezone (en-CA renders ISO shape). */
function ymdInTz(instant: Date, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(instant);
  } catch {
    return instant.toISOString().slice(0, 10);
  }
}

/** Human date-time in a timezone, for result text. */
function fmtInTz(instant: Date, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(instant);
  } catch {
    return instant.toISOString();
  }
}

/** Firestore Timestamp / Date / null to Date | null. */
function toDate(raw: unknown): Date | null {
  if (raw instanceof Date) return raw;
  if (raw && typeof (raw as { toDate?: unknown }).toDate === "function") {
    return (raw as { toDate: () => Date }).toDate();
  }
  return null;
}

/**
 * Contact names by id for listing lines. Contacts from another sub-account are
 * dropped, so it stays safe even if a caller passes ids that didn't come from
 * a tenant-scoped query.
 */
async function contactNamesById(
  subAccountId: string,
  ids: (string | null | undefined)[]
): Promise<Map<string, string>> {
  const db = getAdminDb();
  const unique = [
    ...new Set(
      ids.filter((id): id is string => typeof id === "string" && !!id)
    ),
  ].slice(0, 30);
  const names = new Map<string, string>();
  if (unique.length === 0) return names;
  const snaps = await db.getAll(
    ...unique.map((id) => db.doc(`contacts/${id}`))
  );
  for (const s of snaps) {
    if (
      s.exists &&
      s.data()?.subAccountId === subAccountId &&
      typeof s.data()?.name === "string"
    ) {
      names.set(s.id, s.data()!.name as string);
    }
  }
  return names;
}

const WORKFLOW_TEMPLATES: Record<WorkflowTemplate, string> = {
  blank: "Blank",
  "speed-to-lead": "Speed-to-Lead",
  "appointment-confirmation": "Appointment Confirmation",
  "lead-nurture": "Lead Nurture",
  "stage-change-followup": "Stage-Change Follow-up",
  "no-reply-followup": "No-reply Follow-up",
};

/**
 * Gates the assistant may flip, keyed by friendly name; mirrors the agency
 * feature-gates PATCH route. `emailDomainEnabled` is left out on purpose:
 * disabling it tears down the live Resend sending domain, so that stays in
 * the Manage dialog with its warning.
 */
const FEATURE_GATES: Record<
  string,
  {
    field: string;
    label: string;
    metaRequired?: boolean;
    emailRequired?: boolean;
    /** Enabling runs aiOutboundSmsReadiness against the workspace first. */
    aiSmsPrereqs?: boolean;
  }
> = {
  "api-access": {
    field: "apiAccessEnabledByAgency",
    label: "Public API access",
  },
  broadcasts: {
    field: "broadcastsEnabledByAgency",
    label: "Broadcasts (bulk email)",
  },
  whatsapp: { field: "whatsappEnabledByAgency", label: "WhatsApp" },
  "sms-agent": { field: "smsAgentEnabledByAgency", label: "SMS AI auto-reply" },
  "web-chat": { field: "webChatEnabledByAgency", label: "Web Chat AI" },
  "inbound-voice": {
    field: "inboundVoiceEnabledByAgency",
    label: "Inbound Voice AI",
  },
  "outbound-voice": {
    field: "outboundVoiceEnabledByAgency",
    label: "Outbound Voice",
  },
  "meta-inbox": {
    field: "metaInboxEnabledByAgency",
    label: "Facebook + Instagram inbox",
    metaRequired: true,
  },
  "meta-agent": {
    field: "metaAgentEnabledByAgency",
    label: "Messenger & Instagram AI auto-reply",
    metaRequired: true,
  },
  "social-planner": {
    field: "socialPlannerEnabledByAgency",
    label: "Social Planner",
    metaRequired: true,
  },
  website: { field: "websiteEnabledByAgency", label: "Website builder" },
  community: {
    field: "communityEnabledByAgency",
    label: "Community & Courses",
  },
  "missed-call-text-back": {
    field: "missedCallTextBackEnabledByAgency",
    label: "Missed-Call Text-Back",
  },
  "ai-suite": { field: "aiSuiteEnabledByAgency", label: "AI Suite" },
  labs: { field: "labsEnabledByAgency", label: "Labs (Quick Funnels)" },
  agents: { field: "agentsEnabledByAgency", label: "Agent monitors" },
  payments: {
    field: "paymentsEnabledByAgency",
    label: "Payments (client's own Stripe)",
  },
  "sell-online": {
    field: "sellOnlineEnabledByAgency",
    label: "Sell online (products on the website + buy links; needs Payments)",
    emailRequired: true,
  },
  webinars: {
    field: "webinar1EnabledByAgency",
    label: "Webinars (Webinar1 integration)",
  },
  "web-voice": {
    field: "webVoiceEnabledByAgency",
    label: "Web Voice (talk to the website chat, client's own ElevenLabs key)",
  },
  "ai-texts": {
    field: "aiOutboundSmsEnabledByAgency",
    label: "AI texts (the AI sends the first text; workflow step 'Send AI text')",
    aiSmsPrereqs: true,
  },
  // Get Leads is parked: while the flag is on the assistant can't flip or
  // report it. Once un-parked, enabling doesn't need OUTSCRAPER_API_KEY;
  // searches just 503 with a friendly message until the key exists.
  ...(GET_LEADS_PARKED
    ? {}
    : {
        "get-leads": {
          field: "getLeadsEnabledByAgency",
          label: "Get Leads (prospecting)",
        },
      }),
};

/** Gates a billing plan can bundle; standalone gates (Payments, AI texts...) are left out. */
const PLAN_FEATURE_SLUGS: string[] = Object.keys(FEATURE_GATES).filter((k) =>
  (PLAN_GATE_KEYS as readonly string[]).includes(FEATURE_GATES[k].field)
);

/** Enabled gate labels for one sub-account doc (every gate is opt-in). */
function enabledGateLabels(data: Record<string, unknown>): string[] {
  return Object.entries(FEATURE_GATES)
    .filter(([, g]) => data[g.field] === true)
    .map(([, g]) => g.label);
}

// Registry
export const AI_SUITE_CAPABILITIES: AiSuiteCapability[] = [
  // Agency level
  {
    name: "list_sub_accounts",
    level: "agency",
    requiredRole: "agencyOwner",
    readonly: true,
    menuLabel:
      "Look up your sub-accounts and which feature gates each has enabled",
    description:
      "List this agency's sub-accounts with their ids and which feature gates are enabled. Use it to answer questions about sub-accounts or gates, and ALWAYS use it to resolve a sub-account's name to its id before set_feature_gate.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "List the sub-accounts in this agency.",
    execute: async (ctx) => {
      const snap = await getAdminDb()
        .collection("subAccounts")
        .where("agencyId", "==", ctx.agencyId)
        .limit(50)
        .get();
      if (snap.empty) {
        return { resultText: "This agency has no sub-accounts yet." };
      }
      const lines = snap.docs.map((d) => {
        const data = d.data();
        const gates = enabledGateLabels(data);
        return `- ${data.name ?? "(unnamed)"} — id: ${d.id}${
          data.accountNumber ? `, account #${data.accountNumber}` : ""
        }. Enabled gates: ${gates.length ? gates.join(", ") : "none"}.`;
      });
      return {
        resultText: `Sub-accounts in this agency (${snap.size}):\n${lines.join("\n")}`,
      };
    },
  },
  {
    name: "sub_account_stats",
    level: "agency",
    requiredRole: "agencyOwner",
    readonly: true,
    menuLabel:
      "Get record counts (contacts, deals, tasks, events, quotes) for one sub-account",
    description:
      "Count the records inside one of your sub-accounts — contacts, deals, tasks, calendar events, and quotes. Use for questions like 'how many contacts does Acme have?'. Resolve the sub-account's id with list_sub_accounts first — never guess ids.",
    parameters: {
      type: "object",
      properties: {
        subAccountId: {
          type: "string",
          description:
            "The sub-account's id, exactly as returned by list_sub_accounts.",
        },
        subAccountName: {
          type: "string",
          description: "The sub-account's display name, for the reply.",
        },
      },
      required: ["subAccountId", "subAccountName"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const subAccountId = str(raw, "subAccountId");
      if (!subAccountId) {
        return {
          ok: false,
          error:
            "the sub-account id is required — I need to look it up first (list_sub_accounts)",
        };
      }
      return {
        ok: true,
        args: { subAccountId, subAccountName: str(raw, "subAccountName") },
      };
    },
    summarize: (args) =>
      `Count records in “${args.subAccountName || args.subAccountId}”.`,
    execute: async (ctx, args) => {
      const db = getAdminDb();
      const targetId = args.subAccountId as string;
      const snap = await db.doc(`subAccounts/${targetId}`).get();
      // Re-anchor the model-supplied id to the caller's own agency.
      if (!snap.exists || snap.data()?.agencyId !== ctx.agencyId) {
        throw new CapabilityUserError(
          "That sub-account wasn't found in this agency."
        );
      }
      const count = async (collection: string) =>
        (
          await db
            .collection(collection)
            .where("subAccountId", "==", targetId)
            .count()
            .get()
        ).data().count;
      const [contacts, deals, tasks, events, quotes] = await Promise.all([
        count("contacts"),
        count("deals"),
        count("tasks"),
        count("events"),
        count("quotes"),
      ]);
      const name = (snap.data()?.name as string) || targetId;
      return {
        resultText: `“${name}” record counts: ${contacts} contacts, ${deals} deals, ${tasks} tasks, ${events} calendar events, ${quotes} quotes.`,
      };
    },
  },
  {
    name: "set_feature_gate",
    level: "agency",
    requiredRole: "agencyOwner",
    menuLabel:
      "Enable or disable a feature (broadcasts, API access, WhatsApp, Community, …) for one of your sub-accounts",
    description:
      "Enable or disable one feature gate on one sub-account in this agency. Resolve the sub-account's id with list_sub_accounts first — never guess ids. The dedicated email sending domain gate can't be changed here (it has a destructive tear-down); point the user at the sub-account's Manage dialog for that one.",
    parameters: {
      type: "object",
      properties: {
        subAccountId: {
          type: "string",
          description:
            "The sub-account's id, exactly as returned by list_sub_accounts.",
        },
        subAccountName: {
          type: "string",
          description:
            "The sub-account's display name, for the confirmation card.",
        },
        gate: {
          type: "string",
          enum: Object.keys(FEATURE_GATES),
          description: "Which feature gate to change.",
        },
        enabled: {
          type: "boolean",
          description: "true to enable the feature, false to disable it.",
        },
      },
      required: ["subAccountId", "subAccountName", "gate", "enabled"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const subAccountId = str(raw, "subAccountId");
      if (!subAccountId) {
        return {
          ok: false,
          error:
            "the sub-account id is required — I need to look it up first (list_sub_accounts)",
        };
      }
      const gate = str(raw, "gate");
      const gateDef = FEATURE_GATES[gate];
      if (!gateDef) {
        return {
          ok: false,
          error: `pick a gate: ${Object.keys(FEATURE_GATES).join(", ")}`,
        };
      }
      const enabled = (raw as Record<string, unknown>)?.enabled;
      if (typeof enabled !== "boolean") {
        return {
          ok: false,
          error: "whether to enable or disable the feature is required",
        };
      }
      if (enabled && gateDef.metaRequired && !metaAppConfigured()) {
        return {
          ok: false,
          error:
            "Facebook/Instagram isn't configured on this deployment (META_APP_ID / META_APP_SECRET must be set before this gate can be enabled)",
        };
      }
      if (enabled && gateDef.emailRequired && !emailIsConfigured()) {
        return {
          ok: false,
          error:
            "email isn't configured on this deployment (RESEND_API_KEY / EMAIL_FROM must be set so buyers get their order confirmation)",
        };
      }
      return {
        ok: true,
        args: {
          subAccountId,
          subAccountName: str(raw, "subAccountName"),
          gate,
          enabled,
        },
      };
    },
    summarize: (args) => {
      const g = FEATURE_GATES[args.gate as string];
      return `${args.enabled ? "Enable" : "Disable"} ${g?.label ?? args.gate} for “${
        args.subAccountName || args.subAccountId
      }”.`;
    },
    execute: async (ctx, args) => {
      const g = FEATURE_GATES[args.gate as string];
      const ref = getAdminDb().doc(
        `subAccounts/${args.subAccountId as string}`
      );
      const snap = await ref.get();
      // Model-supplied id: re-anchor to the caller's agency so it can't reach another tenant.
      if (!snap.exists || snap.data()?.agencyId !== ctx.agencyId) {
        throw new CapabilityUserError(
          "That sub-account wasn't found in this agency."
        );
      }
      // Same prerequisite check as the Manage dialog's PATCH route.
      if (args.enabled && g.aiSmsPrereqs) {
        const { aiOutboundSmsReadiness } = await import(
          "@/lib/comms/ai/outbound-sms"
        );
        const readiness = await aiOutboundSmsReadiness(
          snap.id,
          snap.data() as import("@/types").SubAccountDoc
        );
        const unmet = readiness.checks.filter((c) => !c.ok);
        if (unmet.length > 0) {
          throw new CapabilityUserError(
            `AI texts can't be enabled yet. Missing: ${unmet
              .map((c) => `${c.label} (${c.fix})`)
              .join("; ")}`
          );
        }
      }
      await ref.update({
        [g.field]: args.enabled,
        updatedAt: FieldValue.serverTimestamp(),
      });
      // Flat fees bill for any month a gate was on (same rule as applyFeatureGates).
      const feeKey = g.field as string;
      if (
        (FEE_GATE_KEYS as readonly string[]).includes(feeKey) &&
        (args.enabled === true || feeGateOn(snap.data() ?? {}, feeKey as FeeGateKey))
      ) {
        await stampFeaturesOn(snap.id, [feeKey as FeeGateKey]);
      }
      const name =
        (snap.data()?.name as string) || (args.subAccountName as string);
      return {
        resultText: `${args.enabled ? "Enabled" : "Disabled"} ${g.label} for “${name}”. The change applies immediately.`,
        ref: { kind: "subAccount", id: snap.id },
      };
    },
  },
  {
    name: "create_sub_account",
    level: "agency",
    requiredRole: "agencyOwner",
    menuLabel: "Create a new sub-account (client workspace)",
    description:
      "Create a new sub-account (an isolated client workspace) in this agency. Use when the user asks to create/add/set up a new sub-account or client. Optionally start it from one of the agency's Snapshots (a saved bundle of forms, templates, products, and workflows) — resolve the snapshot's id with list_snapshots first, never guess it; if the user mentions 'the usual setup' or a template, ask whether they mean a snapshot.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Display name for the new sub-account / client workspace.",
        },
        slug: {
          type: "string",
          description:
            "Optional URL slug — lowercase letters, numbers, and dashes only. Omit to auto-derive.",
        },
        timezone: {
          type: "string",
          description:
            "Optional IANA timezone, e.g. Australia/Sydney. Defaults to UTC.",
        },
        snapshotId: {
          type: "string",
          description:
            "Optional — id of a Snapshot to apply to the new workspace, exactly as returned by list_snapshots.",
        },
        snapshotName: {
          type: "string",
          description: "The snapshot's name, for the confirmation card.",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const name = str(raw, "name");
      if (!name)
        return { ok: false, error: "a name for the sub-account is required" };
      const slug = str(raw, "slug").toLowerCase();
      if (slug && !SLUG_RE.test(slug)) {
        return {
          ok: false,
          error:
            "the slug may only contain lowercase letters, numbers, and dashes",
        };
      }
      const timezone = str(raw, "timezone") || "UTC";
      return {
        ok: true,
        args: {
          name,
          slug,
          timezone,
          snapshotId: str(raw, "snapshotId"),
          snapshotName: str(raw, "snapshotName"),
        },
      };
    },
    summarize: (args) =>
      `Create a new sub-account named “${args.name}”${
        args.slug ? ` (slug: ${args.slug})` : ""
      }${
        args.snapshotId
          ? ` and apply the “${args.snapshotName || args.snapshotId}” snapshot to it`
          : ""
      }.`,
    execute: async (ctx, args) => {
      // Resolve the snapshot first so a bad id doesn't leave a half-built
      // workspace. Anchored to the caller's agency.
      let snapshot: { name: string; payload: SnapshotPayload } | null = null;
      if (args.snapshotId) {
        const snapSnap = await getAdminDb()
          .doc(`agencies/${ctx.agencyId}/snapshots/${args.snapshotId as string}`)
          .get();
        if (!snapSnap.exists) {
          throw new CapabilityUserError(
            "That snapshot wasn't found in this agency — check the name under Agency → Sub-accounts → Snapshots and ask again."
          );
        }
        const raw = (snapSnap.data()?.payload ?? {}) as Partial<SnapshotPayload>;
        snapshot = {
          name: (snapSnap.data()?.name as string) || (args.snapshotName as string) || snapSnap.id,
          payload: {
            forms: raw.forms ?? [],
            messageTemplates: raw.messageTemplates ?? [],
            products: raw.products ?? [],
            workflows: raw.workflows ?? [],
          },
        };
      }
      const res = await createSubAccountForAgency({
        agencyId: ctx.agencyId,
        uid: ctx.uid,
        email: ctx.email,
        displayName: ctx.displayName,
        name: args.name as string,
        slug: (args.slug as string) ?? "",
        timezone: (args.timezone as string) ?? "UTC",
        accountContact: null,
      });
      let snapshotNote = "";
      if (snapshot) {
        const applied = await applySnapshot(
          getAdminDb(),
          snapshot.payload,
          res.subAccountId,
          { agencyId: ctx.agencyId, createdByUid: ctx.uid }
        );
        snapshotNote = ` Applied the “${snapshot.name}” snapshot: ${applied.formsCreated} forms, ${applied.templatesCreated} templates, ${applied.productsCreated} products, ${applied.workflowsCreated} workflows (imported workflows arrive as drafts — publish them when ready).`;
      }
      return {
        resultText: `Created sub-account “${res.name}” (#${res.accountNumber}). You'll find it under Agency → Sub-accounts.${snapshotNote}`,
        ref: { kind: "subAccount", id: res.subAccountId },
      };
    },
  },
  {
    name: "list_billing_plans",
    level: "agency",
    requiredRole: "agencyOwner",
    readonly: true,
    menuLabel: "List your Client-Billing plans (price + features)",
    description:
      "List this agency's Client-Billing plans with their id, price, feature count, and status. Use this to resolve a plan's id by name before assigning it (assign_billing_plan) — never guess plan ids.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "List billing plans.",
    execute: async (ctx) => {
      const plans = await listPlansForAgency(ctx.agencyId);
      if (plans.length === 0) {
        return {
          resultText:
            "There are no Client-Billing plans yet. Create one with create_billing_plan.",
        };
      }
      const lines = plans.map((p) => {
        const cur = p.currency.toUpperCase();
        const monthly = `${fmtMoney(p.priceMonthlyCents / 100, cur)}/mo`;
        const annual =
          p.priceAnnualCents != null
            ? `, ${fmtMoney(p.priceAnnualCents / 100, cur)}/yr`
            : "";
        const gateCount = Object.values(p.gates).filter(Boolean).length;
        return `• ${p.name} (id: ${p.id}) — ${monthly}${annual} — ${gateCount} feature${
          gateCount === 1 ? "" : "s"
        } — ${p.status}`;
      });
      return { resultText: `Billing plans:\n${lines.join("\n")}` };
    },
  },
  {
    name: "create_billing_plan",
    level: "agency",
    requiredRole: "agencyOwner",
    menuLabel: "Create a Client-Billing plan (price + bundled features)",
    description:
      "Create a Client-Billing plan (a monthly price + an optional annual price + a bundle of features) that the agency can charge sub-accounts for. Charges run on the deployment's own Stripe account. Set includeAllFeatures:true for an all-inclusive plan, or pass a `features` list. TWO RULES BEFORE PROPOSING: (1) the plan NAME must come from the user — if they didn't state one explicitly, ask them what to call it; never invent or silently derive a name. (2) call list_billing_plans first and check whether a matching plan already exists (same name, or same price with the same features) — if it does, don't create a duplicate; suggest assign_billing_plan with the existing plan instead. To then charge a client, follow up with assign_billing_plan.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Plan name, e.g. “Pro” or “Gym Junkies”. 1–60 chars.",
        },
        priceMonthly: {
          type: "number",
          description:
            "Monthly price in whole currency units (dollars), e.g. 99 for $99/month.",
        },
        priceAnnual: {
          type: "number",
          description:
            "Optional annual price in dollars (e.g. 990). Omit for a monthly-only plan.",
        },
        currency: {
          type: "string",
          description: "ISO 4217 code, lowercase. Defaults to usd.",
        },
        includeAllFeatures: {
          type: "boolean",
          description:
            "true = bundle EVERY feature into the plan (all-inclusive). When true, `features` is ignored.",
        },
        features: {
          type: "array",
          items: { type: "string", enum: PLAN_FEATURE_SLUGS },
          description:
            "Specific features to include when includeAllFeatures is not set. Omit for a bare plan (core CRM is always included).",
        },
      },
      required: ["name", "priceMonthly"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const r = (raw ?? {}) as Record<string, unknown>;
      const name = str(raw, "name");
      if (!name) return { ok: false, error: "a plan name is required" };
      if (name.length > 60) {
        return {
          ok: false,
          error: "the plan name must be 60 characters or fewer",
        };
      }
      const monthly = r.priceMonthly;
      if (
        typeof monthly !== "number" ||
        !Number.isFinite(monthly) ||
        monthly <= 0
      ) {
        return {
          ok: false,
          error: "a monthly price greater than 0 is required",
        };
      }
      const priceMonthlyCents = Math.round(monthly * 100);
      if (priceMonthlyCents < 100) {
        return { ok: false, error: "the monthly price must be at least 1.00" };
      }
      let priceAnnualCents: number | null = null;
      if (r.priceAnnual !== undefined && r.priceAnnual !== null) {
        if (
          typeof r.priceAnnual !== "number" ||
          !Number.isFinite(r.priceAnnual) ||
          r.priceAnnual <= 0
        ) {
          return {
            ok: false,
            error:
              "the annual price must be a number greater than 0, or omitted",
          };
        }
        priceAnnualCents = Math.round(r.priceAnnual * 100);
        if (priceAnnualCents < 100) {
          return { ok: false, error: "the annual price must be at least 1.00" };
        }
      }
      const currency = (str(raw, "currency") || "usd").toLowerCase();
      if (!/^[a-z]{3}$/.test(currency)) {
        return {
          ok: false,
          error: "currency must be a 3-letter code like usd or aud",
        };
      }
      const includeAllFeatures = r.includeAllFeatures === true;
      const features = Array.isArray(r.features)
        ? (r.features as unknown[]).filter(
            (f): f is string =>
              typeof f === "string" && PLAN_FEATURE_SLUGS.includes(f)
          )
        : [];
      return {
        ok: true,
        args: {
          name,
          priceMonthlyCents,
          priceAnnualCents,
          currency,
          includeAllFeatures,
          features,
        },
      };
    },
    summarize: (args) => {
      const cur = (args.currency as string).toUpperCase();
      const monthly = `${fmtMoney((args.priceMonthlyCents as number) / 100, cur)}/mo`;
      const annual =
        args.priceAnnualCents != null
          ? ` + ${fmtMoney((args.priceAnnualCents as number) / 100, cur)}/yr`
          : "";
      const feat = args.includeAllFeatures
        ? "all features"
        : `${(args.features as string[]).length} feature(s)`;
      return `Create billing plan “${args.name}” at ${monthly}${annual} with ${feat}.`;
    },
    execute: async (ctx, args) => {
      // All PLAN_GATE_KEYS for includeAllFeatures, else just the named features via FEATURE_GATES.
      const includeAll = args.includeAllFeatures === true;
      const gates = {} as PlanGates;
      for (const key of PLAN_GATE_KEYS) gates[key] = includeAll;
      if (!includeAll) {
        for (const f of args.features as string[]) {
          const def = FEATURE_GATES[f];
          if (
            def &&
            (PLAN_GATE_KEYS as readonly string[]).includes(def.field)
          ) {
            gates[def.field as PlanGateKey] = true;
          }
        }
      }
      // Server-side duplicate guard (holds even if the model skipped
      // list_billing_plans): refuse an active plan with the same name or the
      // same price + gate bundle. Assigning the existing plan is better since
      // its gate edits propagate to every client on it.
      const existing = (await listPlansForAgency(ctx.agencyId)).filter(
        (p) => p.status === "active"
      );
      const wantedName = (args.name as string).trim().toLowerCase();
      const nameClash = existing.find(
        (p) => p.name.trim().toLowerCase() === wantedName
      );
      if (nameClash) {
        throw new CapabilityUserError(
          `A plan named “${nameClash.name}” already exists (id: ${nameClash.id}). Assign it with assign_billing_plan, or pick a different name.`
        );
      }
      const twin = existing.find(
        (p) =>
          p.priceMonthlyCents === (args.priceMonthlyCents as number) &&
          p.currency === (args.currency as string) &&
          PLAN_GATE_KEYS.every((k) => p.gates[k] === gates[k])
      );
      if (twin) {
        throw new CapabilityUserError(
          `The plan “${twin.name}” (id: ${twin.id}) already has this exact price and feature bundle. Assign that plan with assign_billing_plan instead of creating a duplicate.`
        );
      }

      let plan;
      try {
        plan = await createPlanForAgency({
          agencyId: ctx.agencyId,
          name: args.name as string,
          description: null,
          priceMonthlyCents: args.priceMonthlyCents as number,
          priceAnnualCents: (args.priceAnnualCents as number | null) ?? null,
          currency: args.currency as string,
          gates,
        });
      } catch (err) {
        if (err instanceof BillingError)
          throw new CapabilityUserError(err.message);
        throw err;
      }
      const cur = plan.currency.toUpperCase();
      const monthly = `${fmtMoney(plan.priceMonthlyCents / 100, cur)}/mo`;
      const annual =
        plan.priceAnnualCents != null
          ? ` and ${fmtMoney(plan.priceAnnualCents / 100, cur)}/yr`
          : "";
      const gateCount = Object.values(plan.gates).filter(Boolean).length;
      return {
        resultText: `Created plan “${plan.name}” (id: ${plan.id}) — ${monthly}${annual}, ${gateCount} feature${
          gateCount === 1 ? "" : "s"
        } bundled. Assign it to a sub-account with assign_billing_plan to start charging.`,
        ref: { kind: "billingPlan", id: plan.id },
      };
    },
  },
  {
    name: "assign_billing_plan",
    level: "agency",
    requiredRole: "agencyOwner",
    menuLabel: "Assign a billing plan to a sub-account (start charging)",
    description:
      "Assign a Client-Billing plan to one sub-account and start the checkout/subscription. Resolve the sub-account's id with list_sub_accounts and the plan's id with list_billing_plans first — never guess ids. A fresh assignment returns a checkout link the client pays; switching a live subscription re-prices it immediately.",
    parameters: {
      type: "object",
      properties: {
        subAccountId: {
          type: "string",
          description:
            "Target sub-account id, exactly as returned by list_sub_accounts.",
        },
        subAccountName: {
          type: "string",
          description:
            "The sub-account's display name, for the confirmation card.",
        },
        planId: {
          type: "string",
          description:
            "Plan id, exactly as returned by list_billing_plans or create_billing_plan.",
        },
        planName: {
          type: "string",
          description: "The plan's name, for the confirmation card.",
        },
        interval: {
          type: "string",
          enum: ["month", "year"],
          description:
            "Billing cadence. Defaults to month. Use year only if the plan has an annual price.",
        },
        specialPrice: {
          type: "number",
          description:
            "Optional per-client price override in dollars, for the chosen cadence. Omit to use the plan's standard price.",
        },
      },
      required: ["subAccountId", "subAccountName", "planId", "planName"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const r = (raw ?? {}) as Record<string, unknown>;
      const subAccountId = str(raw, "subAccountId");
      if (!subAccountId) {
        return {
          ok: false,
          error:
            "the sub-account id is required — look it up first with list_sub_accounts",
        };
      }
      const planId = str(raw, "planId");
      if (!planId) {
        return {
          ok: false,
          error:
            "the plan id is required — look it up first with list_billing_plans",
        };
      }
      const interval: BillingInterval =
        r.interval === "year" ? "year" : "month";
      let specialPriceCents: number | null = null;
      if (r.specialPrice !== undefined && r.specialPrice !== null) {
        if (
          typeof r.specialPrice !== "number" ||
          !Number.isFinite(r.specialPrice) ||
          r.specialPrice <= 0
        ) {
          return {
            ok: false,
            error:
              "the special price must be a number greater than 0, or omitted",
          };
        }
        specialPriceCents = Math.round(r.specialPrice * 100);
        if (specialPriceCents < 100) {
          return {
            ok: false,
            error: "the special price must be at least 1.00",
          };
        }
      }
      return {
        ok: true,
        args: {
          subAccountId,
          subAccountName: str(raw, "subAccountName"),
          planId,
          planName: str(raw, "planName"),
          interval,
          specialPriceCents,
        },
      };
    },
    summarize: (args) => {
      const cadence = args.interval === "year" ? "annual" : "monthly";
      const special =
        args.specialPriceCents != null
          ? ` at a special price of ${((args.specialPriceCents as number) / 100).toLocaleString("en-US")}`
          : "";
      return `Assign plan “${args.planName}” (${cadence}) to “${
        args.subAccountName || args.subAccountId
      }”${special}.`;
    },
    execute: async (ctx, args) => {
      let result;
      try {
        result = await assignPlanToSubAccount({
          agencyId: ctx.agencyId,
          subAccountId: args.subAccountId as string,
          planId: args.planId as string,
          specialPriceCents: (args.specialPriceCents as number | null) ?? null,
          interval: args.interval as BillingInterval,
        });
      } catch (err) {
        if (err instanceof BillingError)
          throw new CapabilityUserError(err.message);
        throw err;
      }
      const who =
        (args.subAccountName as string) || (args.subAccountId as string);
      if (result.status === "pending" && result.checkoutUrl) {
        return {
          resultText: `Assigned “${args.planName}” to “${who}”. The workspace is now behind an activation screen until payment. Checkout link to send the client:\n${result.checkoutUrl}`,
          ref: { kind: "subAccount", id: args.subAccountId as string },
        };
      }
      return {
        resultText: `Switched “${who}” to the “${args.planName}” plan — the live subscription was re-priced (prorated) and the plan's features applied immediately.`,
        ref: { kind: "subAccount", id: args.subAccountId as string },
      };
    },
  },
  {
    name: "create_one_time_charge",
    level: "agency",
    requiredRole: "agencyOwner",
    menuLabel:
      "Charge a sub-account client once (e.g. “Web design — $500”) via a payment link",
    description:
      "Create a ONE-TIME charge for a sub-account's client (e.g. a web design fee) and get a Stripe payment link to send them. Not a subscription — a single payment, independent of any plan (works for comped clients too). Resolve the sub-account's id with list_sub_accounts first — never guess ids. The description appears on the client's checkout page, so keep it professional.",
    parameters: {
      type: "object",
      properties: {
        subAccountId: {
          type: "string",
          description:
            "Target sub-account id, exactly as returned by list_sub_accounts.",
        },
        subAccountName: {
          type: "string",
          description:
            "The sub-account's display name, for the confirmation card.",
        },
        description: {
          type: "string",
          description:
            "What the charge is for — shown to the client at checkout, e.g. “Web design”. 1–120 chars.",
        },
        amount: {
          type: "number",
          description: "Amount in whole currency units (dollars), e.g. 500.",
        },
        currency: {
          type: "string",
          description: "ISO 4217 code, lowercase. Defaults to usd.",
        },
      },
      required: ["subAccountId", "subAccountName", "description", "amount"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const r = (raw ?? {}) as Record<string, unknown>;
      const subAccountId = str(raw, "subAccountId");
      if (!subAccountId) {
        return {
          ok: false,
          error:
            "the sub-account id is required — look it up first with list_sub_accounts",
        };
      }
      const description = str(raw, "description");
      if (!description || description.length > 120) {
        return {
          ok: false,
          error:
            "a description (1–120 characters) is required — it's what the client sees at checkout",
        };
      }
      const amount = r.amount;
      if (
        typeof amount !== "number" ||
        !Number.isFinite(amount) ||
        amount <= 0
      ) {
        return { ok: false, error: "an amount greater than 0 is required" };
      }
      const amountCents = Math.round(amount * 100);
      if (amountCents < 100) {
        return { ok: false, error: "the amount must be at least 1.00" };
      }
      const currency = (str(raw, "currency") || "usd").toLowerCase();
      if (!/^[a-z]{3}$/.test(currency)) {
        return {
          ok: false,
          error: "currency must be a 3-letter code like usd or aud",
        };
      }
      return {
        ok: true,
        args: {
          subAccountId,
          subAccountName: str(raw, "subAccountName"),
          description,
          amountCents,
          currency,
        },
      };
    },
    summarize: (args) =>
      `One-time charge for “${args.subAccountName || args.subAccountId}”: ${
        args.description
      } — ${fmtMoney((args.amountCents as number) / 100, (args.currency as string).toUpperCase())} (single payment, not a subscription).`,
    execute: async (ctx, args) => {
      // An identical pending charge (description + amount) almost certainly
      // means "re-send the link", not "bill twice".
      const existing = await listChargesForSubAccount(
        ctx.agencyId,
        args.subAccountId as string
      ).catch((err) => {
        if (err instanceof BillingError)
          throw new CapabilityUserError(err.message);
        throw err;
      });
      const dup = existing.find(
        (c) =>
          c.status === "pending" &&
          c.amountCents === (args.amountCents as number) &&
          c.description.trim().toLowerCase() ===
            (args.description as string).trim().toLowerCase()
      );
      if (dup) {
        throw new CapabilityUserError(
          `An identical pending charge already exists (“${dup.description}”). Copy a fresh link for it from the Manage dialog's Billing section instead of billing twice.`
        );
      }
      let result;
      try {
        result = await createOneTimeCharge({
          agencyId: ctx.agencyId,
          subAccountId: args.subAccountId as string,
          createdByUid: ctx.uid,
          description: args.description as string,
          amountCents: args.amountCents as number,
          currency: args.currency as string,
        });
      } catch (err) {
        if (err instanceof BillingError)
          throw new CapabilityUserError(err.message);
        throw err;
      }
      const who =
        (args.subAccountName as string) || (args.subAccountId as string);
      const amt = fmtMoney(
        (args.amountCents as number) / 100,
        (args.currency as string).toUpperCase()
      );
      return {
        resultText: `Created a one-time charge for “${who}”: ${args.description} — ${amt}. Payment link to send the client:\n${result.checkoutUrl}\n\nIt marks itself paid automatically when the client completes checkout.`,
        ref: { kind: "billingCharge", id: result.charge.id },
      };
    },
  },

  // Sub-account level
  {
    name: "my_access",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    menuLabel: "Check which workspaces you can access and your role in each",
    description:
      "Look up which workspaces (sub-accounts) the signed-in user can access and their role in each, plus whether they have agency-level access. Use for questions like 'do I have access to X?', 'what workspaces can I switch to?', or anything about the user's own permissions. It only ever reflects the current user — it cannot look up anyone else, and it cannot change anything.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "Check your workspace access.",
    execute: async (ctx) => {
      // The caller's own membership index (what their switcher shows), keyed
      // by session uid so the model can't point it at another user.
      const snap = await getAdminDb()
        .collection(`userMemberships/${ctx.uid}/subAccounts`)
        .limit(100)
        .get();
      const isAgencyOwner = ctx.subAccountRole === "agencyOwner";
      const lines = snap.docs.map((d) => {
        const data = d.data();
        const marker = d.id === ctx.subAccountId ? " ← this workspace" : "";
        return `- ${data.name ?? d.id}${
          data.accountNumber ? ` (#${data.accountNumber})` : ""
        } — role: ${data.role ?? "member"}${marker}`;
      });
      const agencyLine = isAgencyOwner
        ? "The user is the AGENCY OWNER — full access to every sub-account in the agency (even any not listed above) plus the Agency area (feature gates, creating sub-accounts, agency settings)."
        : "The user does NOT have agency-level access. Only their agency owner can see agency-wide data (e.g. the full list or count of sub-accounts) or change feature gates. To reach another workspace not listed above, they'd need the agency owner to invite them.";
      return {
        resultText: `Workspaces this user can access (${snap.size}):\n${
          lines.length ? lines.join("\n") : "(none listed)"
        }\n\n${agencyLine}\n\nSwitching: the workspace picker in the top header moves between workspaces they belong to.`,
      };
    },
  },
  {
    name: "open_workspace",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    menuLabel:
      "Switch you to another workspace you belong to (via an open button)",
    description:
      "Give the user a button to open another workspace (sub-account) they already have access to — use when they ask to switch/go/move to a different workspace. This never grants access: it only resolves against workspaces the user is already a member of. You cannot switch them yourself; the button does it.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "The target workspace's name (or #account-number) as the user said it.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const query = str(raw, "query");
      if (!query)
        return { ok: false, error: "which workspace to open is required" };
      return { ok: true, args: { query: query.slice(0, 120) } };
    },
    summarize: (args) => `Open the “${args.query}” workspace.`,
    execute: async (ctx, args) => {
      const q = (args.query as string).toLowerCase().replace(/^#/, "");
      // Caller's own memberships, so a link only goes to a workspace they're in.
      const snap = await getAdminDb()
        .collection(`userMemberships/${ctx.uid}/subAccounts`)
        .limit(100)
        .get();
      const rows = snap.docs.map((d) => ({
        id: d.id,
        name:
          typeof d.data().name === "string" ? (d.data().name as string) : d.id,
        accountNumber: d.data().accountNumber as number | undefined,
      }));
      const matches = rows.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          (r.accountNumber != null && String(r.accountNumber) === q)
      );
      if (matches.length === 0) {
        return {
          resultText: `None of the workspaces the user can access match “${args.query}”. They can access: ${
            rows.map((r) => r.name).join(", ") || "(none)"
          }. If they need access to another workspace, their agency owner must invite them.`,
        };
      }
      if (matches.length > 1) {
        return {
          resultText: `Multiple accessible workspaces match “${args.query}”: ${matches
            .map(
              (r) =>
                `${r.name}${r.accountNumber ? ` (#${r.accountNumber})` : ""}`
            )
            .join(", ")}. Ask the user which one they mean.`,
        };
      }
      const target = matches[0];
      if (target.id === ctx.subAccountId) {
        return {
          resultText: `“${target.name}” is the workspace the user is already in — no switch needed.`,
        };
      }
      // User-facing: the chat route short-circuits on `navigate` and shows this with the button.
      return {
        resultText: `You have access to “${target.name}” — click below to switch. You'll land in that workspace's own assistant, which only sees that client's data.`,
        navigate: {
          href: `/sa/${target.id}/ai-suite`,
          label: `Open ${target.name} →`,
        },
      };
    },
  },
  {
    name: "find_contacts",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    menuLabel: "Search this workspace's contacts (name, email, phone, company)",
    description:
      "Search this sub-account's contacts by name, email, phone, or company. Use it to answer 'do I have…' questions, to check for an existing contact before proposing create_contact (avoid duplicates), and to resolve a contact's id before linking a task to them.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Name, email, phone, or company fragment to search for.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const query = str(raw, "query");
      if (!query) return { ok: false, error: "a search term is required" };
      return { ok: true, args: { query: query.slice(0, 120) } };
    },
    summarize: (args) => `Search contacts for “${args.query}”.`,
    execute: async (ctx, args) => {
      const q = (args.query as string).toLowerCase();
      const qDigits = q.replace(/\D/g, "");
      const snap = await getAdminDb()
        .collection("contacts")
        .where("subAccountId", "==", ctx.subAccountId!)
        .limit(500)
        .get();
      const matches = snap.docs
        .filter((d) => {
          const data = d.data();
          const text = [data.name, data.email, data.company]
            .filter((v): v is string => typeof v === "string")
            .join(" ")
            .toLowerCase();
          if (text.includes(q)) return true;
          const phone =
            typeof data.phone === "string" ? data.phone.replace(/\D/g, "") : "";
          return qDigits.length >= 4 && phone.includes(qDigits);
        })
        .slice(0, 8);
      if (matches.length === 0) {
        return {
          resultText: `No contacts matched “${args.query}”${
            snap.size === 500
              ? " (searched the 500 most recently indexed contacts)"
              : ""
          }.`,
        };
      }
      const lines = matches.map((d) => {
        const data = d.data();
        const bits = [
          data.email && `email: ${data.email}`,
          data.phone && `phone: ${data.phone}`,
          data.company && `company: ${data.company}`,
        ].filter(Boolean);
        return `- ${data.name ?? "(unnamed)"} — id: ${d.id}${
          bits.length ? ` (${bits.join(", ")})` : ""
        }`;
      });
      return {
        resultText: `Contacts matching “${args.query}” (${matches.length}):\n${lines.join("\n")}`,
      };
    },
  },
  {
    name: "workspace_stats",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    menuLabel:
      "Get a workspace snapshot — pipeline by stage with values, contacts, open/overdue tasks, upcoming events",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    description:
      "Get a snapshot of this workspace: deal counts + values per pipeline stage, total contacts, open and overdue tasks, upcoming calendar events, and quotes. Use for questions like 'how's my pipeline?', 'how many leads do I have?', or 'what's overdue?'.",
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "Get a snapshot of this workspace.",
    execute: async (ctx) => {
      const db = getAdminDb();
      const said = ctx.subAccountId!;
      const now = new Date();

      const [
        contactsCount,
        quotesCount,
        upcomingEvents,
        dealsSnap,
        openTasksSnap,
      ] = await Promise.all([
        db
          .collection("contacts")
          .where("subAccountId", "==", said)
          .count()
          .get(),
        db.collection("quotes").where("subAccountId", "==", said).count().get(),
        db
          .collection("events")
          .where("subAccountId", "==", said)
          .where("startAt", ">=", now)
          .count()
          .get(),
        db
          .collection("deals")
          .where("subAccountId", "==", said)
          .limit(1000)
          .get(),
        db
          .collection("tasks")
          .where("subAccountId", "==", said)
          .where("completed", "==", false)
          .limit(500)
          .get(),
      ]);

      // Per-pipeline rollup in memory (bounded by the 1000-deal cap above).
      const { loadResolvedPipelines: loadPipelinesForSummary } = await import(
        "@/lib/server/pipelines-service"
      );
      const { dealPipelineId: pipelineIdOf } = await import(
        "@/lib/pipelines/resolve"
      );
      const summaryPipelines = await loadPipelinesForSummary(said);
      const byKey = new Map<string, { count: number; value: number }>();
      let currency = "USD";
      for (const d of dealsSnap.docs) {
        const data = d.data();
        const key = `${pipelineIdOf({ pipelineId: data.pipelineId as string | null | undefined })}:${(data.stageId as string) ?? "new"}`;
        const row = byKey.get(key) ?? { count: 0, value: 0 };
        row.count += 1;
        row.value += typeof data.value === "number" ? data.value : 0;
        byKey.set(key, row);
        if (typeof data.currency === "string" && data.currency)
          currency = data.currency;
      }
      const stageLines: string[] = [];
      let openValue = 0;
      for (const p of summaryPipelines) {
        const pipelineTotal = p.stages.reduce(
          (n, s) => n + (byKey.get(`${p.id}:${s.id}`)?.count ?? 0),
          0,
        );
        // Only name non-default pipelines that hold deals.
        if (p.id !== "default" && pipelineTotal === 0) continue;
        if (summaryPipelines.length > 1) stageLines.push(`  ${p.name}:`);
        for (const s of p.stages) {
          const row = byKey.get(`${p.id}:${s.id}`);
          stageLines.push(
            `  - ${s.label}: ${row?.count ?? 0}${
              row?.value ? ` (${fmtMoney(row.value, currency)})` : ""
            }`,
          );
          if (!s.terminal) openValue += row?.value ?? 0;
        }
      }

      let overdue = 0;
      for (const t of openTasksSnap.docs) {
        const dueAt = t.data().dueAt;
        const due =
          dueAt && typeof dueAt.toDate === "function"
            ? (dueAt.toDate() as Date)
            : null;
        if (due && due < now) overdue += 1;
      }

      return {
        resultText: [
          `Workspace snapshot:`,
          `- Contacts: ${contactsCount.data().count}`,
          `- Pipeline (${dealsSnap.size} deals${
            dealsSnap.size === 1000 ? ", capped at 1000" : ""
          }, open value ${fmtMoney(openValue, currency)}):`,
          ...stageLines,
          `- Open tasks: ${openTasksSnap.size}${overdue ? ` (${overdue} overdue)` : ""}`,
          `- Upcoming calendar events: ${upcomingEvents.data().count}`,
          `- Quotes: ${quotesCount.data().count}`,
        ].join("\n"),
      };
    },
  },
  {
    name: "find_deals",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    menuLabel: "Search this workspace's deals (by title or pipeline stage)",
    description:
      "Search this sub-account's deals by title fragment and/or pipeline stage. Use to answer questions about deals and ALWAYS use it to resolve a deal's id before move_deal_stage — never guess ids.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Optional title fragment to match.",
        },
        stage: {
          type: "string",
          description:
            "Optional stage id to filter by. Default pipeline: " +
            `${STAGE_IDS.join(", ")}; custom pipelines have their own stage ids (workspace_stats shows every pipeline's stages).`,
        },
      },
      additionalProperties: false,
    },
    validate: (raw) => {
      const query = str(raw, "query").slice(0, 120);
      const stage = str(raw, "stage").slice(0, 60);
      if (!query && !stage) {
        return { ok: false, error: "a title fragment or a stage is required" };
      }
      return { ok: true, args: { query, stage } };
    },
    summarize: (args) =>
      `Search deals${args.query ? ` matching “${args.query}”` : ""}${
        args.stage ? ` in stage “${args.stage}”` : ""
      }.`,
    execute: async (ctx, args) => {
      const q = ((args.query as string) || "").toLowerCase();
      const stage = (args.stage as string) || "";
      const snap = await getAdminDb()
        .collection("deals")
        .where("subAccountId", "==", ctx.subAccountId!)
        .limit(500)
        .get();
      const matches = snap.docs
        .filter((d) => {
          const data = d.data();
          if (stage && data.stageId !== stage) return false;
          if (
            q &&
            !String(data.title ?? "")
              .toLowerCase()
              .includes(q)
          )
            return false;
          return true;
        })
        .slice(0, 10);
      if (matches.length === 0) {
        return { resultText: "No deals matched." };
      }
      const lines = matches.map((d) => {
        const data = d.data();
        const stageId = (data.stageId as string) ?? "new";
        const canonical = getStage(stageId);
        const stageLabel = canonical.id === stageId ? canonical.label : stageId;
        const pipelineSuffix =
          typeof data.pipelineId === "string" && data.pipelineId
            ? ` (pipeline: ${data.pipelineId})`
            : "";
        return `- ${data.title} — id: ${d.id}, stage: ${stageLabel}${pipelineSuffix}, value: ${fmtMoney(
          typeof data.value === "number" ? data.value : 0,
          (data.currency as string) || "USD"
        )}, contactId: ${data.contactId ?? "none"}`;
      });
      return { resultText: `Deals (${matches.length}):\n${lines.join("\n")}` };
    },
  },
  {
    name: "create_deal",
    level: "sub-account",
    requiredRole: "subAccountMember",
    menuLabel: "Create a deal for a contact (title, value, pipeline stage)",
    description:
      "Create a deal on the pipeline for an existing contact. Resolve the contact's id with find_contacts first — never guess ids. Ask for the deal value if the user didn't give one.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Deal title, e.g. 'Kitchen renovation'.",
        },
        value: { type: "number", description: "Deal value (0 if unknown)." },
        currency: {
          type: "string",
          description: "Optional 3-letter currency code. Defaults to USD.",
        },
        contactId: {
          type: "string",
          description:
            "The contact's id, exactly as returned by find_contacts.",
        },
        contactName: {
          type: "string",
          description: "The contact's name, for the confirmation card.",
        },
        stage: {
          type: "string",
          description:
            "Optional starting stage id. Defaults to the pipeline's first stage. Default pipeline: " +
            `${STAGE_IDS.join(", ")}.`,
        },
        pipeline: {
          type: "string",
          description:
            "Optional pipeline name or id when the workspace runs several (e.g. 'Fulfillment'). Omit for the default pipeline.",
        },
      },
      required: ["title", "value", "contactId", "contactName"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const title = str(raw, "title");
      if (!title) return { ok: false, error: "a deal title is required" };
      const rawValue = (raw as Record<string, unknown>)?.value;
      const value =
        typeof rawValue === "number"
          ? rawValue
          : typeof rawValue === "string"
            ? Number(rawValue)
            : NaN;
      if (!Number.isFinite(value) || value < 0 || value > 1_000_000_000) {
        return {
          ok: false,
          error: "the deal value must be a number (0 if unknown)",
        };
      }
      const contactId = str(raw, "contactId");
      if (!contactId) {
        return {
          ok: false,
          error:
            "the contact is required — I need to find them first (find_contacts)",
        };
      }
      const currency = (str(raw, "currency") || "USD").toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) {
        return {
          ok: false,
          error: "the currency must be a 3-letter code like USD",
        };
      }
      const stage = str(raw, "stage").slice(0, 60);
      const pipeline = str(raw, "pipeline").slice(0, 60);
      return {
        ok: true,
        args: {
          title,
          value,
          currency,
          contactId,
          contactName: str(raw, "contactName"),
          stage,
          pipeline,
        },
      };
    },
    summarize: (args) =>
      `Create a deal “${args.title}” (${fmtMoney(
        args.value as number,
        args.currency as string
      )}) for ${args.contactName}${
        args.pipeline ? ` in the ${args.pipeline} pipeline` : ""
      }${args.stage ? ` at stage “${args.stage}”` : ""}.`,
    execute: async (ctx, args) => {
      // Model-supplied contact id: verify it's in this workspace.
      const c = await getAdminDb()
        .doc(`contacts/${args.contactId as string}`)
        .get();
      if (!c.exists || c.data()?.subAccountId !== ctx.subAccountId) {
        throw new CapabilityUserError(
          "That contact wasn't found in this workspace."
        );
      }
      // Resolve against the live pipeline definitions. Pipeline accepts a name
      // or id; stage defaults to the pipeline's first stage.
      const { loadResolvedPipelines } = await import(
        "@/lib/server/pipelines-service"
      );
      const pipelines = await loadResolvedPipelines(ctx.subAccountId!);
      const pipelineArg = ((args.pipeline as string) || "").toLowerCase();
      const pipeline = pipelineArg
        ? pipelines.find(
            (p) =>
              p.id.toLowerCase() === pipelineArg ||
              p.name.toLowerCase() === pipelineArg,
          )
        : pipelines[0]; // default pipeline sorts first
      if (!pipeline) {
        throw new CapabilityUserError(
          `I couldn't find a pipeline called "${args.pipeline}". This workspace has: ${pipelines.map((p) => p.name).join(", ")}.`,
        );
      }
      const stageId = (args.stage as string) || pipeline.stages[0].id;
      const stageDef = pipeline.stages.find((s) => s.id === stageId);
      if (!stageDef) {
        throw new CapabilityUserError(
          `The "${pipeline.name}" pipeline has no stage "${stageId}". Its stages: ${pipeline.stages.map((s) => s.id).join(", ")}.`,
        );
      }
      const res = await createDealServerSide({
        subAccountId: ctx.subAccountId!,
        agencyId: ctx.agencyId,
        createdByUid: ctx.uid,
        mode: "live",
        title: args.title as string,
        value: args.value as number,
        currency: args.currency as string,
        contactId: args.contactId as string,
        pipelineId: pipeline.id,
        stageId,
        priority: "medium" as DealPriority,
      });
      return {
        resultText: `Created the deal “${args.title}” (${fmtMoney(
          args.value as number,
          args.currency as string
        )}) for ${args.contactName} in ${stageDef.label}${
          pipeline.id !== "default" ? ` (${pipeline.name} pipeline)` : ""
        }. You'll see it on the Pipeline board.`,
        ref: { kind: "deal", id: res.id },
      };
    },
  },
  {
    name: "move_deal_stage",
    level: "sub-account",
    requiredRole: "subAccountMember",
    menuLabel: "Move a deal to another pipeline stage (including Won / Lost)",
    description:
      "Move an existing deal to a different pipeline stage. Resolve the deal's id with find_deals first — never guess ids. When moving to 'lost', ask the user for a short lost reason.",
    parameters: {
      type: "object",
      properties: {
        dealId: {
          type: "string",
          description: "The deal's id, exactly as returned by find_deals.",
        },
        dealTitle: {
          type: "string",
          description: "The deal's title, for the confirmation card.",
        },
        stage: {
          type: "string",
          description:
            "The stage id to move the deal to (within its own pipeline). Default pipeline: " +
            `${STAGE_IDS.join(", ")}; find_deals shows a deal's pipeline.`,
        },
        lostReason: {
          type: "string",
          description: "Short reason, only when moving to the Lost stage.",
        },
      },
      required: ["dealId", "dealTitle", "stage"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const dealId = str(raw, "dealId");
      if (!dealId) {
        return {
          ok: false,
          error:
            "the deal id is required — I need to find it first (find_deals)",
        };
      }
      const stage = str(raw, "stage").slice(0, 60);
      if (!stage) {
        return { ok: false, error: "the target stage id is required" };
      }
      return {
        ok: true,
        args: {
          dealId,
          dealTitle: str(raw, "dealTitle"),
          stage,
          lostReason: str(raw, "lostReason").slice(0, 300),
        },
      };
    },
    summarize: (args) =>
      `Move the deal “${args.dealTitle || args.dealId}” to stage “${args.stage}”${
        args.lostReason ? ` (reason: ${args.lostReason})` : ""
      }.`,
    execute: async (ctx, args) => {
      // Model-supplied deal id: verify it's in this workspace.
      const snap = await getAdminDb()
        .doc(`deals/${args.dealId as string}`)
        .get();
      if (!snap.exists || snap.data()?.subAccountId !== ctx.subAccountId) {
        throw new CapabilityUserError(
          "That deal wasn't found in this workspace."
        );
      }
      // Use the deal's own pipeline so the stage (and Lost-stage id) is checked against the right list.
      const { loadPipeline, PipelineError } = await import(
        "@/lib/server/pipelines-service"
      );
      const { lostStageId: lostIdOf } = await import(
        "@/lib/pipelines/resolve"
      );
      const dealPipeline = await loadPipeline(
        ctx.subAccountId!,
        (snap.data()?.pipelineId as string | null | undefined) ?? null,
      );
      const stage = args.stage as PipelineStageId;
      const stageDef = dealPipeline.stages.find((s) => s.id === stage);
      if (!stageDef) {
        throw new CapabilityUserError(
          `The "${dealPipeline.name}" pipeline has no stage "${stage}". Its stages: ${dealPipeline.stages.map((s) => s.id).join(", ")}.`,
        );
      }
      try {
        await updateDealServerSide({
          dealId: snap.id,
          userId: ctx.uid,
          expectedSubAccountId: ctx.subAccountId!,
          patch: {
            stageId: stage,
            ...(stage === lostIdOf(dealPipeline)
              ? { lostReason: (args.lostReason as string) || null }
              : {}),
          },
        });
      } catch (err) {
        if (err instanceof PipelineError) {
          throw new CapabilityUserError(err.message);
        }
        throw err;
      }
      const title =
        (snap.data()?.title as string) || (args.dealTitle as string);
      return {
        resultText: `Moved “${title}” to ${stageDef.label}${
          dealPipeline.id !== "default" ? ` (${dealPipeline.name} pipeline)` : ""
        }.`,
        ref: { kind: "deal", id: snap.id },
      };
    },
  },
  {
    name: "list_webhooks",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    readonly: true,
    menuLabel:
      "List this workspace's outbound webhooks and their delivery status",
    description:
      "List this sub-account's outbound webhook subscriptions (id, URL, events, status, last delivery). Use to answer questions about existing webhooks, to check for duplicates before proposing create_webhook, and to resolve the webhookId for send_webhook_test / update_webhook_url.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "List this workspace's webhooks.",
    execute: async (ctx) => {
      const docs = await listSubscriptions(ctx.subAccountId!);
      if (docs.length === 0) {
        return {
          resultText: "This workspace has no webhook subscriptions yet.",
        };
      }
      const lines = docs.map((d) => {
        const events = d.events.length ? d.events.join(", ") : "all events";
        const last =
          d.lastDeliveryStatus != null
            ? `last delivery HTTP ${d.lastDeliveryStatus}`
            : "no deliveries yet";
        return `- [id: ${d.id}] ${d.url} — ${d.mode}, ${d.status}${
          d.pausedReason ? ` (${d.pausedReason})` : ""
        }. Events: ${events}. ${last}.${
          d.description ? ` Label: ${d.description}.` : ""
        }`;
      });
      return {
        resultText: `Webhook subscriptions (${docs.length}):\n${lines.join("\n")}`,
      };
    },
  },
  {
    name: "create_webhook",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    menuLabel:
      "Set up an outbound webhook to n8n / Make / Zapier (with a live test to verify it)",
    description:
      "Create an outbound webhook subscription in this sub-account: events here get POSTed to the user's endpoint (n8n, Make, Zapier, custom). Gather two things conversationally before calling: (1) the trigger — which event(s), all from ONE category (contacts, deals, tasks & events, forms, quotes, bookings, AI agents, conversations); offer the closest event types when they describe a goal like 'when a new lead comes in' → contact.created. (2) the destination URL from their automation tool. n8n gotcha — n8n shows TWO URLs per webhook node: a Test URL containing /webhook-test/ (only works while the n8n editor is listening) and a Production URL containing /webhook/ (only works when the workflow is Active). If the user pastes a /webhook-test/ URL, point this out and ask whether they want the Production URL for a permanent hook (same address with /webhook/ instead) — only proceed with the test URL if they say they're just testing right now. After the user confirms, the webhook is created AND a signed test event is sent immediately to verify the endpoint is live.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            "The destination endpoint URL (e.g. an n8n/Make/Zapier webhook URL). Must be exactly what the user provided.",
        },
        events: {
          type: "array",
          items: { type: "string", enum: [...WEBHOOK_EVENT_TYPES] },
          description:
            "Event types to subscribe to — at least one, all from the same category.",
        },
        description: {
          type: "string",
          description: "Optional short label, e.g. 'n8n new-lead flow'.",
        },
        mode: {
          type: "string",
          enum: ["live", "test"],
          description:
            "Default 'live'. Only use 'test' if the user explicitly wants test-mode API traffic.",
        },
      },
      required: ["url", "events"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const urlCheck = validateWebhookUrl(str(raw, "url"));
      if (!urlCheck.ok)
        return {
          ok: false,
          error: urlCheck.error.toLowerCase().replace(/\.$/, ""),
        };
      const rawEvents = (raw as Record<string, unknown>)?.events;
      const events = Array.isArray(rawEvents)
        ? rawEvents.filter((e): e is WebhookEventType =>
            (WEBHOOK_EVENT_TYPES as readonly string[]).includes(e as string)
          )
        : [];
      if (events.length === 0) {
        return {
          ok: false,
          error: "at least one valid trigger event is required",
        };
      }
      if (!eventsAreSingleCategory(events)) {
        return {
          ok: false,
          error: `all events must be from one category (these span ${[
            ...new Set(events.map((e) => categoryOf(e))),
          ].join(" + ")}) — create one webhook per category`,
        };
      }
      const mode = str(raw, "mode") || "live";
      if (mode !== "live" && mode !== "test") {
        return { ok: false, error: "mode must be 'live' or 'test'" };
      }
      return {
        ok: true,
        args: {
          url: urlCheck.url,
          events,
          description: str(raw, "description").slice(0, 120),
          mode,
        },
      };
    },
    summarize: (args) => {
      const base = `Create a ${args.mode} webhook to ${args.url} for: ${(
        args.events as string[]
      ).join(", ")}. A test event will be sent to verify it.`;
      const info = detectAutomationUrl(args.url as string);
      return info.tool === "n8n" && info.n8nKind === "test"
        ? `${base} ⚠️ This is an n8n TEST URL — it only receives events while the n8n editor is listening. For an always-on hook, use the Production URL instead (same address with /webhook/ instead of /webhook-test/).`
        : base;
    },
    execute: async (ctx, args) => {
      // Same agency gate as the dashboard webhook route: webhooks are part of
      // the public API, so they share the kill switch.
      const subSnap = await getAdminDb()
        .doc(`subAccounts/${ctx.subAccountId!}`)
        .get();
      if (subSnap.data()?.apiAccessEnabledByAgency !== true) {
        throw new CapabilityUserError(
          "API access (which includes webhooks) is disabled for this workspace. Your agency owner can enable it from the agency's sub-account Manage dialog."
        );
      }

      const signingSecret = generateSigningSecret();
      const doc = await createSubscription({
        subAccountId: ctx.subAccountId!,
        agencyId: ctx.agencyId,
        mode: args.mode as "live" | "test",
        url: args.url as string,
        description: (args.description as string) || null,
        events: args.events as WebhookEventType[],
        signingSecret,
        createdByUid: ctx.uid,
      });

      // One signed test delivery so the reply covers "created and your
      // endpoint answered". Tool-aware messaging: n8n's test-vs-production
      // URL trap is the most common failure.
      const test = await sendDirectTestDelivery(doc);
      const urlInfo = detectAutomationUrl(doc.url);
      const isN8nTestUrl = urlInfo.tool === "n8n" && urlInfo.n8nKind === "test";
      let verification: string;
      if (test.ok) {
        verification = `✅ Verified live — a test “${test.type}” event was delivered and your endpoint responded ${test.httpStatus}.`;
        if (isN8nTestUrl) {
          verification += ` ⚠️ Heads-up: this is n8n's TEST URL, so it only responded because the n8n editor is listening right now. Once you stop listening, deliveries will silently fail. For a permanent hook: activate the workflow in n8n, then ask me to switch this webhook to the Production URL (update_webhook_url with switchToN8nProduction) — it becomes ${n8nProductionUrl(
            doc.url
          )}.`;
        }
      } else {
        verification = `⚠️ The webhook was created, but the test delivery failed (${
          test.error ?? `HTTP ${test.httpStatus}`
        }). Real events will still be attempted with retries.`;
        if (isN8nTestUrl) {
          verification += ` This is n8n's TEST URL — it only responds while the n8n editor is in “Listen for test event” mode. Click “Execute workflow” in n8n, then ask me to send another test (send_webhook_test) — or (better, for an always-on hook) use the Production URL instead: ${n8nProductionUrl(
            doc.url
          )} — the workflow must be set to Active.`;
        } else if (urlInfo.tool === "n8n") {
          verification += ` This looks like an n8n Production URL — those only respond once the workflow's Active toggle is ON in n8n. Activate it, then ask me to send another test (send_webhook_test).`;
        } else {
          verification += ` Check the URL is correct and your workflow is listening, then ask me to send another test (send_webhook_test).`;
        }
      }

      return {
        resultText: `Created the webhook to ${doc.url} for ${(
          args.events as string[]
        ).join(
          ", "
        )}.\n${verification}\nSigning secret (shown once — copy it now if you want to verify signatures; n8n/Make work fine without it): ${signingSecret}\nManage it anytime under Settings → Webhooks.`,
        ref: { kind: "webhookSubscription", id: doc.id },
      };
    },
  },
  {
    name: "send_webhook_test",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    menuLabel:
      "Send a test event to an existing webhook (verify n8n / Make / Zapier is receiving)",
    description:
      "Send ONE signed sample event to an EXISTING webhook subscription and report whether the endpoint answered — the in-chat equivalent of the send-test button under Settings → Webhooks. Use when the user wants to (re)verify an endpoint, e.g. their n8n node is now listening after an earlier test failed. Resolve the webhookId with list_webhooks first — never guess ids. Optionally pass eventType to test a specific event the subscription covers (defaults to its first subscribed event). This does NOT create or modify the webhook; it only fires one test delivery (which appears in Logs → Webhooks like any other delivery).",
    parameters: {
      type: "object",
      properties: {
        webhookId: {
          type: "string",
          description: "The subscription id from list_webhooks ([id: ...]).",
        },
        url: {
          type: "string",
          description:
            "The webhook's destination URL — shown to the user in the confirmation so they know which endpoint gets hit.",
        },
        eventType: {
          type: "string",
          enum: [...WEBHOOK_EVENT_TYPES],
          description:
            "Optional: which sample event to send. Must be one the subscription is subscribed to. Omit to use its first subscribed event.",
        },
      },
      required: ["webhookId", "url"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const webhookId = str(raw, "webhookId");
      if (!webhookId) {
        return {
          ok: false,
          error: "webhookId is required — resolve it with list_webhooks first",
        };
      }
      const eventType = str(raw, "eventType");
      if (
        eventType &&
        !(WEBHOOK_EVENT_TYPES as readonly string[]).includes(eventType)
      ) {
        return { ok: false, error: `unknown eventType '${eventType}'` };
      }
      return {
        ok: true,
        args: { webhookId, url: str(raw, "url"), eventType },
      };
    },
    summarize: (args) =>
      `Send a signed test ${
        args.eventType ? `“${args.eventType}” ` : ""
      }event to ${args.url || "the webhook"} and check the response.`,
    execute: async (ctx, args) => {
      // Same agency kill switch as create_webhook.
      const subSnap = await getAdminDb()
        .doc(`subAccounts/${ctx.subAccountId!}`)
        .get();
      if (subSnap.data()?.apiAccessEnabledByAgency !== true) {
        throw new CapabilityUserError(
          "API access (which includes webhooks) is disabled for this workspace. Your agency owner can enable it from the agency's sub-account Manage dialog."
        );
      }

      // Path-scoped under this workspace, so a foreign id just returns null.
      const subscription = await getSubscription(
        ctx.subAccountId!,
        args.webhookId as string
      );
      if (!subscription) {
        throw new CapabilityUserError(
          "That webhook wasn't found in this workspace — run list_webhooks and use one of its ids."
        );
      }
      if (subscription.status === "paused") {
        throw new CapabilityUserError(
          "That webhook is paused, so tests won't send. Resume it under Settings → Webhooks first."
        );
      }
      const eventType = (args.eventType as string) || "";
      if (
        eventType &&
        subscription.events.length > 0 &&
        !subscription.events.includes(eventType as WebhookEventType)
      ) {
        throw new CapabilityUserError(
          `That webhook isn't subscribed to '${eventType}' — it covers: ${subscription.events.join(
            ", "
          )}.`
        );
      }

      const test = await sendDirectTestDelivery(
        subscription,
        eventType ? (eventType as WebhookEventType) : undefined
      );
      const urlInfo = detectAutomationUrl(subscription.url);
      const isN8nTestUrl = urlInfo.tool === "n8n" && urlInfo.n8nKind === "test";
      if (test.ok) {
        let text = `✅ Test “${test.type}” event delivered to ${subscription.url} — the endpoint responded ${test.httpStatus}.`;
        if (isN8nTestUrl) {
          text += ` Heads-up: this is n8n's TEST URL, so it only responded because the n8n editor is listening right now. For an always-on hook: activate the workflow in n8n, then ask me to switch this webhook to the Production URL (update_webhook_url with switchToN8nProduction) — it becomes ${n8nProductionUrl(
            subscription.url
          )}.`;
        }
        return {
          resultText: text,
          ref: { kind: "webhookSubscription", id: subscription.id },
        };
      }
      let text = `⚠️ The test “${test.type}” event to ${subscription.url} failed (${
        test.error ?? `HTTP ${test.httpStatus}`
      }).`;
      if (isN8nTestUrl) {
        text += ` This is n8n's TEST URL — it only responds while the n8n editor is in “Listen for test event” mode. Click “Execute workflow” in n8n, then send another test. For an always-on hook: activate the workflow, then ask me to switch this webhook to the Production URL (update_webhook_url with switchToN8nProduction) — it becomes ${n8nProductionUrl(
          subscription.url
        )}.`;
      } else if (urlInfo.tool === "n8n") {
        text += ` This looks like an n8n Production URL — those only respond once the workflow's Active toggle is ON in n8n. Activate it and try again.`;
      } else {
        text += ` Check the URL is correct and your automation is listening, then try again.`;
      }
      return {
        resultText: text,
        ref: { kind: "webhookSubscription", id: subscription.id },
      };
    },
  },
  {
    name: "update_webhook_url",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    menuLabel:
      "Point an existing webhook at a new URL (e.g. switch n8n test → production)",
    description:
      "Change the destination URL of an EXISTING webhook subscription, then immediately send a signed test event to the NEW URL and report whether it answered. The main use: after a successful test against an n8n TEST URL, the user activates their n8n workflow and asks to 'switch it to production / make it live' — pass switchToN8nProduction: true and the Production URL is derived server-side from the stored test URL (/webhook-test/ → /webhook/); never compute it yourself. For any other destination change, pass newUrl exactly as the user provided it. Resolve the webhookId with list_webhooks first — never guess ids. Events, signing secret, and the subscription's live/test API mode are all unchanged ('production' here means the destination URL, not the mode). If the webhook was paused (e.g. circuit breaker after failed deliveries to a dead URL), it is resumed as part of the switch.",
    parameters: {
      type: "object",
      properties: {
        webhookId: {
          type: "string",
          description: "The subscription id from list_webhooks ([id: ...]).",
        },
        currentUrl: {
          type: "string",
          description:
            "The webhook's CURRENT URL — shown to the user in the confirmation so they know which hook is changing.",
        },
        newUrl: {
          type: "string",
          description:
            "The new destination URL, exactly as the user provided it. Omit when using switchToN8nProduction.",
        },
        switchToN8nProduction: {
          type: "boolean",
          description:
            "True to derive the n8n Production URL from the stored test URL server-side. Mutually exclusive with newUrl.",
        },
      },
      required: ["webhookId", "currentUrl"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const webhookId = str(raw, "webhookId");
      if (!webhookId) {
        return {
          ok: false,
          error: "webhookId is required — resolve it with list_webhooks first",
        };
      }
      const toProduction =
        (raw as Record<string, unknown>)?.switchToN8nProduction === true;
      const newUrlRaw = str(raw, "newUrl");
      if (toProduction && newUrlRaw) {
        return {
          ok: false,
          error: "pass either newUrl or switchToN8nProduction, not both",
        };
      }
      if (!toProduction && !newUrlRaw) {
        return {
          ok: false,
          error: "either newUrl or switchToN8nProduction is required",
        };
      }
      let newUrl = "";
      if (newUrlRaw) {
        const urlCheck = validateWebhookUrl(newUrlRaw);
        if (!urlCheck.ok) {
          return {
            ok: false,
            error: urlCheck.error.toLowerCase().replace(/\.$/, ""),
          };
        }
        newUrl = urlCheck.url;
      }
      return {
        ok: true,
        args: {
          webhookId,
          currentUrl: str(raw, "currentUrl"),
          newUrl,
          switchToN8nProduction: toProduction,
        },
      };
    },
    summarize: (args) =>
      args.switchToN8nProduction
        ? `Switch the webhook ${
            args.currentUrl || args.webhookId
          } to its n8n Production URL (/webhook-test/ → /webhook/) and send a test to verify it's live.`
        : `Point the webhook ${args.currentUrl || args.webhookId} at ${
            args.newUrl
          } and send a test to verify it's live.`,
    execute: async (ctx, args) => {
      // Same agency kill switch as create_webhook.
      const subSnap = await getAdminDb()
        .doc(`subAccounts/${ctx.subAccountId!}`)
        .get();
      if (subSnap.data()?.apiAccessEnabledByAgency !== true) {
        throw new CapabilityUserError(
          "API access (which includes webhooks) is disabled for this workspace. Your agency owner can enable it from the agency's sub-account Manage dialog."
        );
      }

      // Path-scoped under this workspace, so a foreign id just returns null.
      const subscription = await getSubscription(
        ctx.subAccountId!,
        args.webhookId as string
      );
      if (!subscription) {
        throw new CapabilityUserError(
          "That webhook wasn't found in this workspace — run list_webhooks and use one of its ids."
        );
      }

      let targetUrl: string;
      if (args.switchToN8nProduction) {
        const info = detectAutomationUrl(subscription.url);
        if (info.tool !== "n8n") {
          throw new CapabilityUserError(
            `That webhook's URL (${subscription.url}) doesn't look like an n8n URL, so there's no Production URL to derive — provide the new URL explicitly instead.`
          );
        }
        if (info.n8nKind !== "test") {
          throw new CapabilityUserError(
            `That webhook already points at an n8n Production URL (${subscription.url}) — nothing to switch.`
          );
        }
        targetUrl = n8nProductionUrl(subscription.url);
      } else {
        targetUrl = args.newUrl as string;
      }
      if (targetUrl === subscription.url) {
        throw new CapabilityUserError(
          `That webhook already points at ${targetUrl} — nothing to change.`
        );
      }

      // Repointing resumes a paused hook (usually the breaker tripping on the
      // old dead URL); updateSubscription resets the failure counter.
      const wasPaused = subscription.status === "paused";
      await updateSubscription(ctx.subAccountId!, subscription.id, {
        url: targetUrl,
        ...(wasPaused ? { status: "active" as const } : {}),
      });

      const test = await sendDirectTestDelivery({
        ...subscription,
        url: targetUrl,
        status: "active",
      });
      const urlInfo = detectAutomationUrl(targetUrl);
      const prefix = `Webhook updated: ${subscription.url} → ${targetUrl}${
        wasPaused ? " (and resumed — it had been paused)" : ""
      }.`;
      if (test.ok) {
        let text = `${prefix}\n✅ Verified live — a test “${test.type}” event was delivered to the new URL and it responded ${test.httpStatus}.`;
        if (urlInfo.tool === "n8n" && urlInfo.n8nKind === "production") {
          text += ` Your n8n workflow is live end to end — real events will flow to it from now on.`;
        } else if (urlInfo.tool === "n8n" && urlInfo.n8nKind === "test") {
          text += ` ⚠️ Note: the new URL is an n8n TEST URL — it only responds while the n8n editor is listening.`;
        }
        return {
          resultText: text,
          ref: { kind: "webhookSubscription", id: subscription.id },
        };
      }
      let text = `${prefix}\n⚠️ But the test to the new URL failed (${
        test.error ?? `HTTP ${test.httpStatus}`
      }). Real events will still be attempted with retries.`;
      if (urlInfo.tool === "n8n" && urlInfo.n8nKind === "production") {
        text += ` n8n Production URLs only respond once the workflow's Active toggle is ON — publish/activate the workflow in n8n, then ask me to send another test (send_webhook_test).`;
      } else {
        text += ` Check the URL is correct and your automation is listening, then ask me to send another test (send_webhook_test).`;
      }
      return {
        resultText: text,
        ref: { kind: "webhookSubscription", id: subscription.id },
      };
    },
  },
  {
    name: "create_community",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    menuLabel:
      "Set up a new community with its first course and lesson (returns the live URLs)",
    description:
      "Set up a new community (a Skool-style group with a feed + classroom) in this sub-account, including its first course and first lesson, and return the live URLs. Gather conversationally before calling: the community's name, who can join (open, or approval-required), an optional one-line tagline, the first lesson's title, and optionally a YouTube/Vimeo video URL and/or lesson text. Everything is created PUBLISHED and live on confirm. Free-to-join communities only — for a paid community, point the user at Sidebar → Community (pricing needs PayPal setup).",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The community's name." },
        tagline: {
          type: "string",
          description: "Optional one-line tagline shown on the community card.",
        },
        about: {
          type: "string",
          description: "Optional longer description for the About panel.",
        },
        joinPolicy: {
          type: "string",
          enum: ["open", "approval"],
          description:
            "'open' = anyone with the link joins instantly (default); 'approval' = join requests need admin approval.",
        },
        courseTitle: {
          type: "string",
          description:
            "Optional first-course title. Defaults to 'Getting started'.",
        },
        lessonTitle: {
          type: "string",
          description: "The first lesson's title.",
        },
        lessonVideoUrl: {
          type: "string",
          description: "Optional YouTube or Vimeo URL for the first lesson.",
        },
        lessonText: {
          type: "string",
          description:
            "Optional written content for the first lesson (plain text).",
        },
      },
      required: ["name", "lessonTitle"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const name = str(raw, "name");
      if (!name)
        return { ok: false, error: "a name for the community is required" };
      const lessonTitle = str(raw, "lessonTitle");
      if (!lessonTitle) {
        return { ok: false, error: "a title for the first lesson is required" };
      }
      const joinPolicy = str(raw, "joinPolicy") || "open";
      if (joinPolicy !== "open" && joinPolicy !== "approval") {
        return {
          ok: false,
          error: "the join policy must be 'open' or 'approval'",
        };
      }
      return {
        ok: true,
        args: {
          name,
          tagline: str(raw, "tagline"),
          about: str(raw, "about"),
          joinPolicy,
          courseTitle: str(raw, "courseTitle") || "Getting started",
          lessonTitle,
          lessonVideoUrl: str(raw, "lessonVideoUrl"),
          lessonText: str(raw, "lessonText").slice(0, 8000),
        },
      };
    },
    summarize: (args) =>
      `Create the community “${args.name}” (${
        args.joinPolicy === "approval"
          ? "join requests need approval"
          : "open to join"
      }, free) with a published “${args.courseTitle}” course and first lesson “${
        args.lessonTitle
      }”${args.lessonVideoUrl ? " (with video)" : ""} — live immediately.`,
    execute: async (ctx, args) => {
      const subSnap = await getAdminDb()
        .doc(`subAccounts/${ctx.subAccountId!}`)
        .get();
      if (subSnap.data()?.communityEnabledByAgency !== true) {
        throw new CapabilityUserError(
          "Community & Courses is disabled for this workspace. Your agency owner can enable it from the agency's sub-account Manage dialog."
        );
      }

      // Group, course, section, lesson, all published so the links work immediately.
      const group = await createGroupServerSide({
        subAccountId: ctx.subAccountId!,
        agencyId: ctx.agencyId,
        createdByUid: ctx.uid,
        name: args.name as string,
        tagline: (args.tagline as string) || undefined,
        about: (args.about as string) || undefined,
        access: "free",
        joinPolicy: args.joinPolicy as "open" | "approval",
        status: "published",
      });
      const course = await createCourseServerSide({
        subAccountId: ctx.subAccountId!,
        agencyId: ctx.agencyId,
        groupId: group.id,
        title: args.courseTitle as string,
        published: true,
      });
      const section = await createSectionServerSide({
        subAccountId: ctx.subAccountId!,
        groupId: group.id,
        courseId: course.id,
        title: "Getting started",
      });
      const lesson = await createLessonServerSide({
        subAccountId: ctx.subAccountId!,
        groupId: group.id,
        courseId: course.id,
        sectionId: section.id,
        title: args.lessonTitle as string,
      });
      const { videoError } = await updateLessonServerSide({
        subAccountId: ctx.subAccountId!,
        groupId: group.id,
        courseId: course.id,
        lessonId: lesson.id,
        patch: {
          published: true,
          videoUrl: (args.lessonVideoUrl as string) || null,
          bodyHtml: args.lessonText
            ? textToBodyHtml(args.lessonText as string)
            : "",
        },
      });

      const base = process.env.NEXT_PUBLIC_APP_URL ?? "";
      const communityUrl = `${base}/c/${ctx.subAccountId}/${group.slug}/community`;
      const lessonUrl = `${base}/c/${ctx.subAccountId}/${group.slug}/classroom/${course.id}/${lesson.id}`;
      const videoNote = videoError
        ? " (⚠️ the video URL wasn't recognized — YouTube/Vimeo links only; add it in the classroom editor)"
        : args.lessonVideoUrl
          ? " with video"
          : "";
      return {
        resultText: `Your community “${group.name}” is live.\nCommunity feed: ${communityUrl}\nFirst lesson “${lesson.title}”${videoNote}: ${lessonUrl}\nMembers sign in via a magic link (tied to their contact record) — share the community URL to invite them${
          args.joinPolicy === "approval"
            ? "; join requests will wait for your approval"
            : ""
        }. Manage everything under Sidebar → Community.`,
        ref: { kind: "communityGroup", id: group.id },
      };
    },
  },
  {
    name: "create_workflow",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    menuLabel:
      "Create an automation workflow from a starter template (as a draft)",
    description:
      "Create a new automation workflow (as a draft) from a starter template in this sub-account. Use when the user asks to create/build/add a workflow or automation.",
    parameters: {
      type: "object",
      properties: {
        template: {
          type: "string",
          enum: [
            "blank",
            "speed-to-lead",
            "appointment-confirmation",
            "lead-nurture",
            "stage-change-followup",
            "no-reply-followup",
          ],
          description:
            "Which starter to use. 'blank' for an empty workflow, or a named template.",
        },
        name: {
          type: "string",
          description: "Optional name. Defaults to the template's name.",
        },
        formId: {
          type: "string",
          description:
            "Optional: pin a form-triggered workflow (e.g. speed-to-lead) to ONE form so it only fires for that form's submissions. Use the id exactly as returned by list_forms. Omit = fires for every form.",
        },
        formName: {
          type: "string",
          description: "The form's name (required when formId is set).",
        },
      },
      required: ["template"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const template = str(raw, "template");
      if (!(template in WORKFLOW_TEMPLATES)) {
        return {
          ok: false,
          error:
            "pick a template: blank, speed-to-lead, appointment-confirmation, lead-nurture, stage-change-followup, or no-reply-followup",
        };
      }
      const name = str(raw, "name");
      const formId = str(raw, "formId");
      return {
        ok: true,
        args: { template, name, formId, formName: str(raw, "formName") },
      };
    },
    summarize: (args) => {
      const label = WORKFLOW_TEMPLATES[args.template as WorkflowTemplate];
      return `Create a “${label}” workflow (draft)${
        args.name ? ` named “${args.name}”` : ""
      }${args.formId ? `, triggered only by the “${args.formName || args.formId}” form` : ""}.`;
    },
    execute: async (ctx, args) => {
      const template = args.template as WorkflowTemplate;
      const label = WORKFLOW_TEMPLATES[template];
      const formId = (args.formId as string) || "";
      if (formId) {
        // Re-anchor the model-supplied form id to this workspace.
        const form = await getFormForSubAccount(ctx.subAccountId!, formId);
        if (!form) {
          throw new CapabilityUserError(
            "That form wasn't found in this workspace — check list_forms."
          );
        }
      }
      const id = await createWorkflowServerSide({
        subAccountId: ctx.subAccountId!,
        createdByUid: ctx.uid,
        name: (args.name as string) || label,
        template,
      });
      if (formId) {
        const wf = await getWorkflow(ctx.subAccountId!, id);
        if (wf) {
          await updateWorkflowServerSide({
            subAccountId: ctx.subAccountId!,
            workflowId: id,
            patch: {
              trigger: { ...wf.trigger, type: "form.submitted", formId },
            },
          });
        }
      }
      return {
        resultText: `Created the “${label}” workflow as a draft${
          formId ? `, triggered only by the “${args.formName || formId}” form` : ""
        }. Review its steps (ask me to configure them, or open Workflows), then publish it.`,
        ref: { kind: "workflow", id },
      };
    },
  },
  {
    name: "create_contact",
    level: "sub-account",
    requiredRole: "subAccountMember",
    menuLabel: "Add a new contact (with optional tags)",
    description:
      "Add a new contact to this sub-account. Use when the user asks to add/create a contact, lead, or person. Check for an existing contact with find_contacts first so you don't create a duplicate.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Contact's full name." },
        email: { type: "string", description: "Optional email address." },
        phone: { type: "string", description: "Optional phone number." },
        company: { type: "string", description: "Optional company name." },
        tags: {
          type: "array",
          items: { type: "string" },
          description: 'Optional tags to apply, e.g. ["vip", "referral"].',
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const name = str(raw, "name");
      if (!name) return { ok: false, error: "a contact name is required" };
      const email = str(raw, "email").toLowerCase();
      if (email && !EMAIL_RE.test(email)) {
        return { ok: false, error: "that email address doesn't look valid" };
      }
      const rawTags = (raw as Record<string, unknown>)?.tags;
      const tags = Array.isArray(rawTags)
        ? rawTags
            .filter((t): t is string => typeof t === "string")
            .map((t) => t.trim().slice(0, 40))
            .filter(Boolean)
            .slice(0, 10)
        : [];
      return {
        ok: true,
        args: {
          name,
          email,
          phone: str(raw, "phone"),
          company: str(raw, "company"),
          tags,
        },
      };
    },
    summarize: (args) => {
      const tags = args.tags as string[] | undefined;
      return `Add a new contact “${args.name}”${args.email ? ` (${args.email})` : ""}${
        tags && tags.length ? ` tagged ${tags.join(", ")}` : ""
      }.`;
    },
    execute: async (ctx, args) => {
      const res = await createContactServerSide({
        subAccountId: ctx.subAccountId!,
        agencyId: ctx.agencyId,
        createdByUid: ctx.uid,
        mode: "live",
        name: args.name as string,
        email: (args.email as string) ?? "",
        phone: (args.phone as string) ?? "",
        company: (args.company as string) ?? "",
        address: "",
        source: "ai-suite",
        tags: (args.tags as string[]) ?? [],
      });
      return {
        resultText: `Added contact “${args.name}”. Open Contacts to see the full profile.`,
        ref: { kind: "contact", id: res.id },
      };
    },
  },
  {
    name: "create_task",
    level: "sub-account",
    requiredRole: "subAccountMember",
    menuLabel: "Create a task, with an optional due date and linked contact",
    description:
      "Create a task (to-do) in this sub-account, optionally with a due date and linked to a contact. Use when the user asks to add/create a task or reminder. To link a contact, resolve their id with find_contacts first — never guess ids.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "What the task is." },
        notes: { type: "string", description: "Optional extra detail." },
        dueAt: {
          type: "string",
          description:
            "Optional due date as YYYY-MM-DD. Convert relative dates ('tomorrow', 'next Friday') using today's date from the system prompt.",
        },
        contactId: {
          type: "string",
          description:
            "Optional id of an existing contact to link, exactly as returned by find_contacts.",
        },
        contactName: {
          type: "string",
          description:
            "The linked contact's name (required when contactId is set).",
        },
      },
      required: ["title"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const title = str(raw, "title");
      if (!title) return { ok: false, error: "a task title is required" };
      const dueAt = str(raw, "dueAt");
      if (dueAt && (!ISO_DATE_RE.test(dueAt) || isNaN(Date.parse(dueAt)))) {
        return {
          ok: false,
          error: "the due date must be a valid ISO date like 2026-07-10",
        };
      }
      const contactId = str(raw, "contactId");
      return {
        ok: true,
        args: {
          title,
          notes: str(raw, "notes"),
          dueAt,
          contactId,
          contactName: str(raw, "contactName"),
        },
      };
    },
    summarize: (args) =>
      `Create a task “${args.title}”${args.dueAt ? ` due ${args.dueAt}` : ""}${
        args.contactName ? ` linked to ${args.contactName}` : ""
      }.`,
    execute: async (ctx, args) => {
      const contactId = (args.contactId as string) || null;
      if (contactId) {
        // Model-supplied id: confirm it's a contact in this sub-account so the
        // task can't be attached to another tenant's record.
        const c = await getAdminDb().doc(`contacts/${contactId}`).get();
        if (!c.exists || c.data()?.subAccountId !== ctx.subAccountId) {
          throw new CapabilityUserError(
            "The linked contact wasn't found in this workspace."
          );
        }
      }
      const dueAtStr = (args.dueAt as string) || "";
      const res = await createTaskServerSide({
        subAccountId: ctx.subAccountId!,
        agencyId: ctx.agencyId,
        createdByUid: ctx.uid,
        mode: "live",
        title: args.title as string,
        notes: (args.notes as string) ?? "",
        // Date-only input -> midday UTC so it lands on the right day in any likely timezone.
        dueAt: dueAtStr ? new Date(`${dueAtStr}T12:00:00Z`) : null,
        contactId,
        dealId: null,
        eventId: null,
      });
      return {
        resultText: `Created task “${args.title}”${
          dueAtStr ? ` due ${dueAtStr}` : ""
        }${args.contactName ? ` linked to ${args.contactName}` : ""}. You'll find it under Tasks.`,
        ref: { kind: "task", id: res.id },
      };
    },
  },
  {
    name: "find_tasks",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    menuLabel: "See your open tasks — today, overdue, or upcoming",
    description:
      "List this workspace's open (incomplete) tasks, filtered to today / overdue / upcoming, or everything open. Dates are evaluated in the workspace's timezone. Use for questions like 'what's on today?', 'anything overdue?', and ALWAYS use it to resolve a task's id before complete_task — never guess ids. For today's calendar, also call find_events.",
    parameters: {
      type: "object",
      properties: {
        filter: {
          type: "string",
          enum: ["today", "overdue", "upcoming", "all-open"],
          description:
            "'today' = due today; 'overdue' = past due; 'upcoming' = due later; 'all-open' (default) = every incomplete task, grouped.",
        },
      },
      additionalProperties: false,
    },
    validate: (raw) => {
      const filter = str(raw, "filter") || "all-open";
      if (!["today", "overdue", "upcoming", "all-open"].includes(filter)) {
        return {
          ok: false,
          error: "filter must be today, overdue, upcoming, or all-open",
        };
      }
      return { ok: true, args: { filter } };
    },
    summarize: (args) =>
      args.filter === "all-open"
        ? "List all open tasks."
        : `List ${args.filter} tasks.`,
    execute: async (ctx, args) => {
      const tz = await subAccountTimezone(ctx.subAccountId!);
      const today = ymdInTz(new Date(), tz);
      const snap = await getAdminDb()
        .collection("tasks")
        .where("subAccountId", "==", ctx.subAccountId!)
        .where("completed", "==", false)
        .limit(300)
        .get();

      type Row = {
        id: string;
        title: string;
        due: string | null; // YYYY-MM-DD in the workspace tz
        contactId: string | null;
      };
      const rows: Row[] = snap.docs.map((d) => {
        const data = d.data();
        const dueAt = toDate(data.dueAt);
        return {
          id: d.id,
          title: (data.title as string) ?? "(untitled)",
          due: dueAt ? ymdInTz(dueAt, tz) : null,
          contactId: typeof data.contactId === "string" ? data.contactId : null,
        };
      });

      const bucketOf = (r: Row) =>
        r.due === null
          ? "no-date"
          : r.due < today
            ? "overdue"
            : r.due === today
              ? "today"
              : "upcoming";
      const wanted =
        args.filter === "all-open"
          ? rows
          : rows.filter((r) => bucketOf(r) === args.filter);
      if (wanted.length === 0) {
        return {
          resultText:
            args.filter === "all-open"
              ? "No open tasks — all clear."
              : `No ${args.filter} tasks.`,
        };
      }

      wanted.sort((a, b) =>
        (a.due ?? "9999-99-99") < (b.due ?? "9999-99-99") ? -1 : 1
      );
      const shown = wanted.slice(0, 15);
      const names = await contactNamesById(
        ctx.subAccountId!,
        shown.map((r) => r.contactId)
      );
      const line = (r: Row) =>
        `- ${r.title} — id: ${r.id}${
          r.due
            ? `, due ${r.due}${bucketOf(r) === "overdue" ? " (OVERDUE)" : ""}`
            : ", no due date"
        }${
          r.contactId
            ? `, contact: ${names.get(r.contactId) ?? r.contactId}`
            : ""
        }`;

      let body: string;
      if (args.filter === "all-open") {
        const sections = (["overdue", "today", "upcoming", "no-date"] as const)
          .map((bucket) => {
            const items = shown.filter((r) => bucketOf(r) === bucket);
            if (!items.length) return null;
            const label = {
              overdue: "Overdue",
              today: "Due today",
              upcoming: "Upcoming",
              "no-date": "No due date",
            }[bucket];
            return `${label}:\n${items.map(line).join("\n")}`;
          })
          .filter(Boolean);
        body = sections.join("\n");
      } else {
        body = shown.map(line).join("\n");
      }
      const more =
        wanted.length > shown.length
          ? `\n(+${wanted.length - shown.length} more — see the Tasks page)`
          : "";
      return {
        resultText: `Open tasks (${wanted.length}, dates in ${tz}):\n${body}${more}`,
      };
    },
  },
  {
    name: "complete_task",
    level: "sub-account",
    requiredRole: "subAccountMember",
    menuLabel: "Mark a task as done",
    description:
      "Mark one of this workspace's tasks as completed. Resolve the task's id with find_tasks first — never guess ids. This fires the same task.completed webhook + contact-timeline activity as ticking it off on the Tasks page.",
    parameters: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "The task's id, exactly as returned by find_tasks.",
        },
        taskTitle: {
          type: "string",
          description: "The task's title, for the confirmation card.",
        },
      },
      required: ["taskId", "taskTitle"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const taskId = str(raw, "taskId");
      if (!taskId) {
        return {
          ok: false,
          error:
            "the task id is required — I need to find it first (find_tasks)",
        };
      }
      return { ok: true, args: { taskId, taskTitle: str(raw, "taskTitle") } };
    },
    summarize: (args) =>
      `Mark the task “${args.taskTitle || args.taskId}” as done.`,
    execute: async (ctx, args) => {
      // Model-supplied id: verify it's in this workspace.
      const snap = await getAdminDb()
        .doc(`tasks/${args.taskId as string}`)
        .get();
      if (!snap.exists || snap.data()?.subAccountId !== ctx.subAccountId) {
        throw new CapabilityUserError(
          "That task wasn't found in this workspace."
        );
      }
      const title =
        (snap.data()?.title as string) || (args.taskTitle as string);
      if (snap.data()?.completed === true) {
        return {
          resultText: `“${title}” is already marked done — nothing to change.`,
          ref: { kind: "task", id: snap.id },
        };
      }
      await setTaskCompletedServerSide({
        taskId: snap.id,
        completed: true,
        userId: ctx.uid,
        expectedSubAccountId: ctx.subAccountId!,
      });
      return {
        resultText: `Marked “${title}” as done.`,
        ref: { kind: "task", id: snap.id },
      };
    },
  },
  {
    name: "find_events",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    menuLabel: "See what's on the calendar — today, this week, or upcoming",
    description:
      "List this workspace's upcoming calendar events (today / next 7 days / everything upcoming), in the workspace's timezone. Use for questions like 'what's on today?' or 'what does my week look like?'. Pair with find_tasks for a full daily agenda.",
    parameters: {
      type: "object",
      properties: {
        range: {
          type: "string",
          enum: ["today", "week", "all-upcoming"],
          description:
            "'today' = rest of today; 'week' (default) = the next 7 days; 'all-upcoming' = everything from now on.",
        },
      },
      additionalProperties: false,
    },
    validate: (raw) => {
      const range = str(raw, "range") || "week";
      if (!["today", "week", "all-upcoming"].includes(range)) {
        return {
          ok: false,
          error: "range must be today, week, or all-upcoming",
        };
      }
      return { ok: true, args: { range } };
    },
    summarize: (args) =>
      args.range === "today"
        ? "List today's calendar events."
        : args.range === "week"
          ? "List this week's calendar events."
          : "List all upcoming calendar events.",
    execute: async (ctx, args) => {
      const tz = await subAccountTimezone(ctx.subAccountId!);
      const now = new Date();
      // Window ends at midnight (workspace tz) after today / day 7. Date.UTC
      // handles month and year rollover.
      const [y, m, d] = ymdInTz(now, tz).split("-").map(Number);
      const endOf = (daysAhead: number) => {
        const rolled = new Date(Date.UTC(y, m - 1, d + daysAhead + 1));
        return utcFromWallClock(
          rolled.getUTCFullYear(),
          rolled.getUTCMonth() + 1,
          rolled.getUTCDate(),
          0,
          tz
        );
      };
      const windowEnd =
        args.range === "today"
          ? endOf(0)
          : args.range === "week"
            ? endOf(6)
            : null;

      // Uses the events(subAccountId, startAt) composite index.
      let q = getAdminDb()
        .collection("events")
        .where("subAccountId", "==", ctx.subAccountId!)
        .where("startAt", ">=", now);
      if (windowEnd) q = q.where("startAt", "<", windowEnd);
      // Paged so imported Google events (staff calendars, dropped here) can't
      // push real events out of the 50 shown.
      const ordered = q.orderBy("startAt", "asc");
      const rows: FirebaseFirestore.QueryDocumentSnapshot[] = [];
      let cursor: FirebaseFirestore.QueryDocumentSnapshot | null = null;
      for (let page = 0; page < 10 && rows.length < 50; page++) {
        const pageSnap: FirebaseFirestore.QuerySnapshot = await (cursor
          ? ordered.startAfter(cursor)
          : ordered
        )
          .limit(100)
          .get();
        for (const doc of pageSnap.docs) {
          if (doc.data().status === "cancelled" || doc.data().source === "google") continue;
          if (rows.length < 50) rows.push(doc);
        }
        if (pageSnap.size < 100) break;
        cursor = pageSnap.docs[pageSnap.docs.length - 1];
      }
      if (rows.length === 0) {
        return {
          resultText:
            args.range === "today"
              ? "Nothing (left) on the calendar today."
              : args.range === "week"
                ? "Nothing on the calendar in the next 7 days."
                : "No upcoming calendar events.",
        };
      }
      const shown = rows.slice(0, 15);
      const names = await contactNamesById(
        ctx.subAccountId!,
        shown.map((doc) =>
          typeof doc.data().contactId === "string"
            ? (doc.data().contactId as string)
            : null
        )
      );
      const lines = shown.map((doc) => {
        const data = doc.data();
        const startAt = toDate(data.startAt);
        const contactId =
          typeof data.contactId === "string" ? data.contactId : null;
        return `- ${data.title ?? "(untitled)"} — ${
          startAt ? fmtInTz(startAt, tz) : "(no time)"
        }${data.location ? `, at ${data.location}` : ""}${
          contactId ? `, contact: ${names.get(contactId) ?? contactId}` : ""
        }`;
      });
      const more =
        rows.length > shown.length
          ? `\n(+${rows.length - shown.length} more — see the Calendar page)`
          : "";
      return {
        resultText: `Upcoming events (${rows.length}, times in ${tz}):\n${lines.join("\n")}${more}`,
      };
    },
  },
  {
    name: "create_event",
    level: "sub-account",
    requiredRole: "subAccountMember",
    menuLabel:
      "Book a calendar event (date + time, optionally linked to a contact)",
    description:
      "Create a calendar event in this workspace. The date and time are interpreted in the WORKSPACE's timezone. Convert relative dates ('tomorrow', 'next Friday') using today's date from the system prompt, and ask for a time if the user didn't give one. To link a contact, resolve their id with find_contacts first — never guess ids.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "What the event is, e.g. 'Call with Jane'.",
        },
        date: { type: "string", description: "Event date as YYYY-MM-DD." },
        time: {
          type: "string",
          description:
            "Start time as 24-hour HH:MM in the workspace timezone, e.g. 14:00.",
        },
        durationMinutes: {
          type: "number",
          description: "Optional length in minutes (5–480). Defaults to 60.",
        },
        contactId: {
          type: "string",
          description:
            "Optional id of an existing contact to link, exactly as returned by find_contacts.",
        },
        contactName: {
          type: "string",
          description:
            "The linked contact's name (required when contactId is set).",
        },
        location: {
          type: "string",
          description: "Optional location or meeting spot.",
        },
        notes: { type: "string", description: "Optional extra detail." },
      },
      required: ["title", "date", "time"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const title = str(raw, "title");
      if (!title) return { ok: false, error: "an event title is required" };
      const date = str(raw, "date");
      if (!ISO_DATE_RE.test(date) || isNaN(Date.parse(date))) {
        return {
          ok: false,
          error: "the date must be a valid ISO date like 2026-07-10",
        };
      }
      const time = str(raw, "time");
      if (!TIME_24H_RE.test(time)) {
        return {
          ok: false,
          error: "the time must be 24-hour HH:MM, e.g. 14:00",
        };
      }
      const rawDuration = (raw as Record<string, unknown>)?.durationMinutes;
      const duration =
        rawDuration === undefined || rawDuration === null
          ? 60
          : typeof rawDuration === "number"
            ? rawDuration
            : Number(rawDuration);
      if (!Number.isFinite(duration) || duration < 5 || duration > 480) {
        return {
          ok: false,
          error: "the duration must be between 5 and 480 minutes",
        };
      }
      return {
        ok: true,
        args: {
          title,
          date,
          time,
          durationMinutes: Math.round(duration),
          contactId: str(raw, "contactId"),
          contactName: str(raw, "contactName"),
          location: str(raw, "location").slice(0, 200),
          notes: str(raw, "notes").slice(0, 2000),
        },
      };
    },
    summarize: (args) =>
      `Create the event “${args.title}” on ${args.date} at ${args.time} (${args.durationMinutes} min, workspace time)${
        args.contactName ? ` with ${args.contactName}` : ""
      }.`,
    execute: async (ctx, args) => {
      const contactId = (args.contactId as string) || null;
      if (contactId) {
        // Model-supplied id: verify it's in this workspace.
        const c = await getAdminDb().doc(`contacts/${contactId}`).get();
        if (!c.exists || c.data()?.subAccountId !== ctx.subAccountId) {
          throw new CapabilityUserError(
            "The linked contact wasn't found in this workspace."
          );
        }
      }
      const tz = await subAccountTimezone(ctx.subAccountId!);
      const [y, m, d] = (args.date as string).split("-").map(Number);
      const [hh, mm] = (args.time as string).split(":").map(Number);
      const startAt = utcFromWallClock(y, m, d, hh * 60 + mm, tz);
      const endAt = new Date(
        startAt.getTime() + (args.durationMinutes as number) * 60_000
      );
      const res = await createEventServerSide({
        subAccountId: ctx.subAccountId!,
        agencyId: ctx.agencyId,
        createdByUid: ctx.uid,
        mode: "live",
        title: args.title as string,
        startAt,
        endAt,
        contactId,
        location: (args.location as string) ?? "",
        notes: (args.notes as string) ?? "",
      });
      return {
        resultText: `Booked “${args.title}” for ${fmtInTz(startAt, tz)} (${tz}, ${args.durationMinutes} min)${
          args.contactName ? ` with ${args.contactName}` : ""
        }. You'll see it on the Calendar.`,
        ref: { kind: "event", id: res.id },
      };
    },
  },
  {
    name: "list_members",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    readonly: true,
    menuLabel: "List this workspace's members and pending invites",
    description:
      "List this sub-account's members (name, email, role, status) and any pending invites. Use to answer questions about who has access, and ALWAYS use it before invite_member to check the person isn't already a member or already invited.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "List this workspace's members and pending invites.",
    execute: async (ctx) => {
      const db = getAdminDb();
      const [membersSnap, invitesSnap] = await Promise.all([
        db
          .collection(`subAccounts/${ctx.subAccountId!}/subAccountMembers`)
          .limit(100)
          .get(),
        db
          .collection("invites")
          .where("subAccountId", "==", ctx.subAccountId!)
          .where("acceptedByUid", "==", null)
          .where("revokedAt", "==", null)
          .limit(50)
          .get(),
      ]);
      const memberLines = membersSnap.docs
        .filter((d) => d.data().status !== "removed")
        .map((d) => {
          const data = d.data();
          const who =
            (data.displayName as string) || (data.email as string) || d.id;
          const email =
            data.displayName && data.email ? ` (${data.email})` : "";
          return `- ${who}${email} — role: ${data.role ?? "member"}${
            data.status && data.status !== "active" ? `, ${data.status}` : ""
          }`;
        });
      const inviteLines = invitesSnap.docs.map((d) => {
        const data = d.data();
        return `- ${data.email} — invited as ${
          data.subAccountRole ?? "collaborator"
        }, pending (hasn't signed up yet)`;
      });
      return {
        resultText: [
          `Members (${memberLines.length}):`,
          memberLines.length ? memberLines.join("\n") : "(none)",
          "",
          `Pending invites (${inviteLines.length}):`,
          inviteLines.length ? inviteLines.join("\n") : "(none)",
        ].join("\n"),
      };
    },
  },
  {
    name: "invite_member",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    menuLabel:
      "Invite someone to this workspace by email (as admin or collaborator)",
    description:
      "Add someone (by email) to this sub-account as 'admin' (manages members + settings) or 'collaborator' (works the data, no member management). If the email is NEW, they get an email with a signup link and the invite stays pending until they sign up. If the email ALREADY has an account, they're added to this workspace directly (nothing to accept) and emailed a notification — this is how someone already in another sub-account gets added here. Re-adding an existing member just updates their role. Ask which role the user wants if they didn't say; default to collaborator when they just say 'invite'.",
    parameters: {
      type: "object",
      properties: {
        email: {
          type: "string",
          description: "The invitee's email address.",
        },
        role: {
          type: "string",
          enum: ["admin", "collaborator"],
          description:
            "'admin' manages members + settings; 'collaborator' works the data only.",
        },
      },
      required: ["email", "role"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const email = str(raw, "email").toLowerCase();
      if (!email || !EMAIL_RE.test(email)) {
        return { ok: false, error: "a valid email address is required" };
      }
      const role = str(raw, "role");
      if (role !== "admin" && role !== "collaborator") {
        return {
          ok: false,
          error: "the role must be 'admin' or 'collaborator'",
        };
      }
      return { ok: true, args: { email, role } };
    },
    summarize: (args) =>
      `Invite ${args.email} to this workspace as ${
        args.role === "admin" ? "an admin" : "a collaborator"
      } (they'll get a signup email).`,
    execute: async (ctx, args) => {
      let res;
      try {
        res = await createInviteServerSide({
          subAccountId: ctx.subAccountId!,
          invitedByUid: ctx.uid,
          email: args.email as string,
          role: args.role as "admin" | "collaborator",
        });
      } catch (err) {
        if (err instanceof MemberAddBlockedError) {
          throw new CapabilityUserError(err.message);
        }
        throw err;
      }
      const roleLabel = res.role === "admin" ? "Admin" : "Collaborator";

      // Existing account: added directly, no signup.
      if (res.added) {
        if (res.alreadyMember) {
          return {
            resultText: `${res.email} was already a member of “${res.subAccountName}” — their role is now ${roleLabel}.`,
            ref: { kind: "subAccount", id: res.subAccountId },
          };
        }
        const note = res.mailed ? " They've been emailed a notification." : "";
        return {
          resultText: `Added ${res.email} to “${res.subAccountName}” as ${roleLabel} (they already had an account, so there was nothing to accept).${note}`,
          ref: { kind: "sub-account", id: res.subAccountId },
        };
      }

      // New email: pending invite until they sign up.
      const reusedNote = res.reused
        ? " There was already a pending invite for them — it's been updated to this role and re-sent."
        : "";
      const delivery = res.mailed
        ? `The invite email is on its way.`
        : `No email was sent (${
            res.mailError
              ? "the send failed"
              : "email isn't configured on this deployment"
          }) — share this signup link with them directly: ${res.inviteUrl}`;
      return {
        resultText: `Invited ${res.email} to “${res.subAccountName}” as ${roleLabel}.${reusedNote} ${delivery} Pending invites are managed under Settings → Members.`,
        ref: { kind: "invite", id: res.inviteId },
      };
    },
  },
  {
    name: "research_website_reference",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    readonly: true,
    menuLabel:
      "Read a reference website's content to inform a site you're drafting",
    description:
      "Fetch a public web page's main content (markdown) so you can draft website copy, services, and positioning in a similar style — use this BEFORE create_website whenever the user names a reference site ('make it like fitness.com'). Also useful to read the client's existing site. Returns the page text; if the deployment has no Firecrawl key or the page can't be read, you'll get a note saying so — then draft from the user's description instead. Never quote the reference site verbatim in the new site's copy.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            "Full http(s) URL of the page to read, e.g. https://fitness.com.",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
    validate: (raw) => {
      let url = str(raw, "url");
      if (url && !/^https?:\/\//i.test(url) && /^[\w-]+(\.[\w-]+)+/.test(url)) {
        // Users often say "like fitness.com"; accept a bare domain.
        url = `https://${url}`;
      }
      if (!url || !/^https?:\/\/.+\..+/i.test(url) || url.length > 300) {
        return { ok: false, error: "a valid http(s) URL is required" };
      }
      return { ok: true, args: { url } };
    },
    summarize: (args) => `Read ${args.url} for reference.`,
    execute: async (ctx, args) => {
      if (!firecrawlIsConfigured()) {
        return {
          resultText:
            "Firecrawl isn't configured on this deployment, so external sites can't be read. Draft the website from the user's own description instead (don't mention configuration details unless asked).",
        };
      }
      try {
        const page = await scrapeUrl(
          args.url as string,
          // The Agency Assistant is the agency's own tool, so its reads aren't the client's.
          ctx.subAccountId && !ctx.delegatedFromAgency
            ? { subAccountId: ctx.subAccountId }
            : { agencyInternal: true },
        );
        const excerpt = page.markdown.slice(0, 5000);
        return {
          resultText: `Reference page${page.title ? ` “${page.title}”` : ""} (${page.sourceUrl}):\n---\n${excerpt}${
            page.markdown.length > 5000 ? "\n… (truncated)" : ""
          }`,
        };
      } catch (err) {
        const status = err instanceof FirecrawlError ? ` (${err.status})` : "";
        return {
          resultText: `That page couldn't be read${status} — it may be blocked or unavailable. Draft the website from the user's description instead.`,
        };
      }
    },
  },
  {
    name: "get_website_prefill",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    readonly: true,
    menuLabel:
      "Check what's already known for a website draft (business details, defaults, site slots)",
    description:
      "Look up what this workspace already knows before drafting a website: the business name, saved contact email/phone, the booking link (the default CTA), how many of the site slots are used, and whether the website builder is enabled/configured. ALWAYS call this before create_website (and before asking the user questions) so you only ask for what's genuinely missing — never ask for something this lookup already provides.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "Check the workspace's website prefill details.",
    execute: async (ctx) => {
      const db = getAdminDb();
      const [subSnap, profileSnap, sitesSnap] = await Promise.all([
        db.doc(`subAccounts/${ctx.subAccountId!}`).get(),
        db.doc(`subAccounts/${ctx.subAccountId!}/aiAgent/profile`).get(),
        db.collection(`subAccounts/${ctx.subAccountId!}/website`).get(),
      ]);
      const sub = (subSnap.data() ?? {}) as Record<string, unknown>;
      const contact = (sub.accountContact ?? {}) as {
        email?: string | null;
        phone?: string | null;
      };
      const businessName =
        (profileSnap.data()?.businessName as string | undefined) ||
        (sub.name as string | undefined) ||
        null;
      const bookingLink =
        typeof sub.bookingLink === "string" &&
        /^https?:\/\//i.test(sub.bookingLink)
          ? sub.bookingLink
          : null;

      const gateOn = sub.websiteEnabledByAgency === true;
      const lines = [
        `Website builder enabled by agency: ${gateOn ? "yes" : "NO — the agency owner must enable it before any build (tell the user this up front)"}`,
        `Builder configured on this deployment: ${gitpageIsConfigured() ? "yes" : "NO (GITPAGE_API_KEY missing — builds will fail)"}`,
        `Site slots used: ${sitesSnap.size} of ${MAX_WEBSITES_PER_SUBACCOUNT}${
          sitesSnap.size >= MAX_WEBSITES_PER_SUBACCOUNT
            ? " — FULL, one must be removed first"
            : ""
        }`,
        `Business name: ${businessName ?? "(unknown — ask the user)"}`,
        `Contact email (default for the site): ${contact.email ?? "(none saved — ask the user)"}`,
        `Contact phone: ${contact.phone ?? "(none saved)"}`,
        `Booking link (default CTA): ${bookingLink ?? "(none saved — ask the user where the main button should go)"}`,
        "No street address is stored anywhere — always ask the user for it when a niche template or contact page is wanted.",
      ];
      return { resultText: lines.join("\n") };
    },
  },
  {
    name: "create_website",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    menuLabel:
      "Create and build a website for this workspace (via the website builder)",
    description:
      "Create a website and submit a REAL build via the website builder — use when the user asks to build/make/create a website or landing page. Workflow: (1) call get_website_prefill FIRST — it tells you the business name, saved contact email, default CTA link, and remaining site slots, so you only ask the user for what's genuinely missing; (2) if they name a reference site, call research_website_reference and mirror its tone/services WITHOUT copying text; (3) pick the closest niche template — gym_fitness for gyms/trainers, home_services for trades (plumbers, electricians, cleaners), real_estate for agents, agency_consulting for studios/consultancies/B2B services, ai_consulting for AI strategy/readiness/governance advisors, ai_automation for AI agent / workflow-automation / chatbot agencies — or 'none' for anything else; (4) NICHE SITES NEED THE BUSINESS'S STREET ADDRESS (street + city) — ask for it if unknown, or use niche 'none' without a contact page — EXCEPT ai_consulting and ai_automation, which are usually remote and may omit the address; (5) features and benefits are each EXACTLY 3 short comma-separated phrases (max 60 chars total); (6) build_type 'vsl' is a single-page video funnel — only use it when the user has a video embed URL; default 'local'. QUALITY: 'premium' is the default and what you should use — a studio-grade design-system build with the strongest copy model, generated photography, and the workspace's own contact form + AI chat widget wired in automatically (on publish the chat bot's knowledge base is seeded from the site, the live hostname is allow-listed, and a speed-to-lead workflow is created on the form). Offer the user a design direction by calling list_website_concepts for the niche and letting them pick (optional — gitpage picks a good default). Pass any REAL facts they give you (team, numbers, testimonials, offer) in `premium` — never invent them; blank is fine. Contact email and the main button link default from the workspace's saved details when omitted. Confirming spends one of the agency's website builds; a premium site goes live in ~10–20 minutes (standard ~1–3) on the Website page.",
    parameters: {
      type: "object",
      properties: {
        site_name: {
          type: "string",
          description: "Short label for the site card, e.g. the business name.",
        },
        build_type: {
          type: "string",
          enum: ["local", "vsl"],
          description:
            "'local' = multi-page business site (default). 'vsl' = single-page video funnel; requires video_link.",
        },
        niche: {
          type: "string",
          enum: ["gym_fitness", "home_services", "real_estate", "agency_consulting", "ai_consulting", "ai_automation", "none"],
          description:
            "Vertical template. Forces a 5-page site and requires the business street address. 'none' = generic build.",
        },
        concept: {
          type: "string",
          description:
            "Premium only: a design-direction id from list_website_concepts (for the same niche). Omit to let gitpage choose.",
        },
        hero_motion: {
          type: "string",
          enum: ["still", "loop", "atmosphere"],
          description: "Premium only: hero treatment. Omit for the concept's default.",
        },
        include_form: {
          type: "boolean",
          description:
            "Premium only. Wire the workspace's contact form into the site (default true).",
        },
        include_chat: {
          type: "boolean",
          description:
            "Premium only. Embed the workspace's AI chat widget on every page (default true).",
        },
        include_voice: {
          type: "boolean",
          description:
            "Premium only. Turn on Web Voice (visitors talk to the chat) when the site publishes — only takes effect if the workspace already has a ready ElevenLabs connection (AI Agents → Web Chat → Voice). Default true; false leaves voice as it is.",
        },
        premium: {
          type: "object",
          description:
            "Premium only — REAL facts the copywriter may use verbatim. Only include what the user actually gave you; leave fields out otherwise. Multi-value fields are plain text, one entry per line, with ' | ' between columns.",
          properties: {
            tagline: { type: "string", description: "≤120 chars." },
            founded_year: { type: "string", description: "Four-digit year." },
            brand_voice: { type: "string", description: "Up to 5 comma-separated words, e.g. 'direct, athletic, warm'." },
            metrics: { type: "string", description: "One per line as 'Label: Value' (≤4), e.g. 'Google rating: 4.9'." },
            team: { type: "string", description: "One per line: 'Name | Role | Credentials | What they do' (≤6)." },
            testimonials: { type: "string", description: "One per line: 'Quote | Name | Role' (≤6). Real quotes only." },
            offer_headline: { type: "string", description: "≤110 chars." },
            offer_bullets: { type: "string", description: "One per line (≤5)." },
            offer_fine: { type: "string", description: "≤160 chars." },
            gallery_notes: { type: "string", description: "Art direction for the generated photography (≤600 chars)." },
            social_links: { type: "string", description: "One per line: 'Label | https://…' (≤6)." },
            case_studies: { type: "string", description: "Agency / AI niches: one per line 'Client | Result | What you did' (≤4). Real results only." },
            tools: { type: "string", description: "AI niches: comma-separated tools/platforms they build with (≤12)." },
            reference_notes: { type: "string", description: "Anything else for the copywriter (≤4000 chars) — e.g. the reference site's positioning in your own words." },
          },
          additionalProperties: false,
        },
        heading: {
          type: "string",
          description:
            "Site heading / title, max 80 chars. Usually the business name plus a hook.",
        },
        hero_statement: {
          type: "string",
          description: "One-line subheading under the heading, max 80 chars.",
        },
        features: {
          type: "string",
          description:
            "Exactly 3 short comma-separated phrases, max 60 chars total, e.g. 'Coach-led, HR tracked, Progressive'.",
        },
        benefits: {
          type: "string",
          description:
            "Exactly 3 short comma-separated phrases, max 60 chars total, e.g. 'Adapt fast, Stay durable, Train sharper'.",
        },
        contact_email: {
          type: "string",
          description:
            "Public contact email for the site. Omit to use the workspace's saved account contact.",
        },
        cta_link: {
          type: "string",
          description:
            "http(s) URL the site's main button points at (booking page, phone tel: is NOT allowed — must be http/https). Omit to use the workspace's saved booking link.",
        },
        include_faq: {
          type: "boolean",
          description: "Include an FAQ section. Default true.",
        },
        color_scheme: {
          type: "string",
          enum: [...GITPAGE_COLOR_SCHEMES],
          description:
            "'Dark Mode' suits gyms/bold brands; 'Standard' otherwise.",
        },
        language: { type: "string", enum: [...GITPAGE_LANGUAGES] },
        design_color_palette: {
          type: "string",
          enum: [...GITPAGE_DESIGN_COLOR_PALETTES],
          description:
            "Use 'Custom' only when the user gives specific brand colours.",
        },
        custom_colors: {
          type: "string",
          description:
            "Only with design_color_palette 'Custom': three hex colours, e.g. '#5B4BFF,#EEF0FF,#00E5A8'.",
        },
        design_typography: {
          type: "string",
          enum: [...GITPAGE_DESIGN_TYPOGRAPHY],
        },
        design_layout: { type: "string", enum: [...GITPAGE_DESIGN_LAYOUT] },
        design_components: {
          type: "string",
          enum: [...GITPAGE_DESIGN_COMPONENTS],
        },
        design_interactions: {
          type: "string",
          enum: [...GITPAGE_DESIGN_INTERACTIONS],
        },
        design_buttons: { type: "string", enum: [...GITPAGE_DESIGN_BUTTONS] },
        design_contact_form: {
          type: "string",
          enum: [...GITPAGE_DESIGN_CONTACT_FORM],
        },
        design_icons: { type: "string", enum: [...GITPAGE_DESIGN_ICONS] },
        include_services_page: {
          type: "boolean",
          description:
            "Generic local builds only (niche forces all pages). Default true.",
        },
        include_contact_page: {
          type: "boolean",
          description:
            "Generic local builds only. Requires the business street address in `business`.",
        },
        include_privacy_page: { type: "boolean" },
        include_terms_page: { type: "boolean" },
        services_list: {
          type: "string",
          description:
            "Optional short description of the services offered. Omit to let the builder generate them.",
        },
        video_link: {
          type: "string",
          description:
            "VSL builds only: http(s) EMBED URL of the video (e.g. https://www.youtube.com/embed/...).",
        },
        business: {
          type: "object",
          description:
            "Business details for the contact page / niche templates. Only include what the user actually provided — never invent an address.",
          properties: {
            name: { type: "string" },
            street: { type: "string" },
            city: { type: "string" },
            state: { type: "string" },
            country: { type: "string" },
            zip: { type: "string" },
            phone: { type: "string" },
            email: { type: "string" },
            opening_hours: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      required: ["heading", "hero_statement", "features", "benefits"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const heading = str(raw, "heading");
      if (!heading) return { ok: false, error: "a site heading is required" };
      if (heading.length > 80) {
        return {
          ok: false,
          error: "the heading must be 80 characters or fewer",
        };
      }
      const heroStatement = str(raw, "hero_statement");
      if (!heroStatement || heroStatement.length > 80) {
        return {
          ok: false,
          error: "a hero statement (max 80 characters) is required",
        };
      }
      const features = str(raw, "features");
      const benefits = str(raw, "benefits");
      if (!features || features.length > 60) {
        return {
          ok: false,
          error:
            "features must be 3 short comma-separated phrases, max 60 characters total",
        };
      }
      if (!benefits || benefits.length > 60) {
        return {
          ok: false,
          error:
            "benefits must be 3 short comma-separated phrases, max 60 characters total",
        };
      }

      const buildType = str(raw, "build_type") === "vsl" ? "vsl" : "local";
      const nicheRaw = str(raw, "niche");
      const niche: Niche | null = isNicheKey(nicheRaw) ? nicheRaw : null;

      const quality = "premium" as const; // Standard builds are no longer offered
      const concept = str(raw, "concept").slice(0, 60) || null;
      const heroMotionRaw = str(raw, "hero_motion");
      const heroMotion =
        heroMotionRaw === "still" || heroMotionRaw === "loop" || heroMotionRaw === "atmosphere"
          ? heroMotionRaw
          : null;
      const premiumRaw = ((raw as Record<string, unknown>)?.premium ?? {}) as Record<string, unknown>;
      const premiumDetails: WebsitePremiumDetails = { ...blankPremiumDetails() };
      let premiumGiven = false;
      for (const key of Object.keys(premiumDetails) as Array<keyof WebsitePremiumDetails>) {
        const v = premiumRaw[key];
        if (typeof v === "string" && v.trim()) {
          premiumDetails[key] = v.trim();
          premiumGiven = true;
        }
      }
      if (quality === "premium" && premiumGiven) {
        const detailErrors = validatePremiumDetails(premiumDetails);
        const first = Object.entries(detailErrors)[0];
        if (first) {
          return { ok: false, error: `premium.${first[0]}: ${first[1]}` };
        }
      }

      const videoLink = str(raw, "video_link");
      if (buildType === "vsl") {
        if (!videoLink || !/^https?:\/\/.+/i.test(videoLink)) {
          return {
            ok: false,
            error:
              "a VSL funnel needs the video's http(s) embed URL — ask the user for it (or build a 'local' site instead)",
          };
        }
      }

      const contactEmail = str(raw, "contact_email").toLowerCase();
      if (contactEmail && !EMAIL_RE.test(contactEmail)) {
        return { ok: false, error: "that contact email doesn't look valid" };
      }
      const ctaLink = str(raw, "cta_link");
      if (ctaLink && !/^https?:\/\/.+/i.test(ctaLink)) {
        return {
          ok: false,
          error: "the CTA link must start with http:// or https://",
        };
      }

      const inList = (value: string, list: readonly string[]) =>
        list.includes(value);
      const enumOr = (
        key: string,
        list: readonly string[],
        fallback: string
      ): string => {
        const v = str(raw, key);
        return v && inList(v, list) ? v : fallback;
      };

      const designPalette = enumOr(
        "design_color_palette",
        GITPAGE_DESIGN_COLOR_PALETTES,
        "Modern / Startup"
      );
      const customColors = str(raw, "custom_colors");
      if (
        designPalette === "Custom" &&
        !/^#?[0-9a-f]{6}\s*,\s*#?[0-9a-f]{6}\s*,\s*#?[0-9a-f]{6}$/i.test(
          customColors.trim()
        )
      ) {
        return {
          ok: false,
          error:
            "a Custom palette needs three hex colours separated by commas, e.g. '#5B4BFF,#EEF0FF,#00E5A8'",
        };
      }

      const bizRaw = ((raw as Record<string, unknown>)?.business ??
        {}) as Record<string, unknown>;
      const bizStr = (key: string): string => {
        const v = bizRaw[key];
        return typeof v === "string" ? v.trim().slice(0, 160) : "";
      };
      const business = {
        name: bizStr("name"),
        street: bizStr("street"),
        city: bizStr("city"),
        state: bizStr("state"),
        country: bizStr("country"),
        zip: bizStr("zip"),
        phone: bizStr("phone"),
        email: bizStr("email").toLowerCase(),
        opening_hours: bizStr("opening_hours"),
      };
      if (business.email && !EMAIL_RE.test(business.email)) {
        return { ok: false, error: "the business email doesn't look valid" };
      }

      const wantsContactPage =
        (raw as Record<string, unknown>)?.include_contact_page === true;
      if (
        buildType === "local" &&
        (niche || wantsContactPage) &&
        (!business.street || !business.city)
      ) {
        return {
          ok: false,
          error: niche
            ? "niche templates include a contact page, which needs the business's street address and city — ask the user for them (or use niche 'none' without a contact page)"
            : "a contact page needs the business's street address and city — ask the user for them (or leave the contact page off)",
        };
      }

      return {
        ok: true,
        args: {
          siteName: str(raw, "site_name").slice(0, 60),
          buildType,
          niche,
          quality,
          concept: quality === "premium" ? concept : null,
          heroMotion: quality === "premium" ? heroMotion : null,
          includeForm:
            quality === "premium" &&
            (raw as Record<string, unknown>)?.include_form !== false,
          includeChat:
            quality === "premium" &&
            (raw as Record<string, unknown>)?.include_chat !== false,
          includeVoice:
            quality === "premium" &&
            (raw as Record<string, unknown>)?.include_voice !== false,
          premiumDetails: quality === "premium" && premiumGiven ? premiumDetails : null,
          heading,
          heroStatement,
          features,
          benefits,
          contactEmail,
          ctaLink,
          includeFaq: (raw as Record<string, unknown>)?.include_faq !== false,
          colorScheme: enumOr(
            "color_scheme",
            GITPAGE_COLOR_SCHEMES,
            "Standard"
          ),
          language: enumOr("language", GITPAGE_LANGUAGES, "English"),
          designPalette,
          customColors: designPalette === "Custom" ? customColors : "",
          designTypography: enumOr(
            "design_typography",
            GITPAGE_DESIGN_TYPOGRAPHY,
            "Professional / Corporate"
          ),
          designLayout: enumOr(
            "design_layout",
            GITPAGE_DESIGN_LAYOUT,
            "Spacious"
          ),
          designComponents: enumOr(
            "design_components",
            GITPAGE_DESIGN_COMPONENTS,
            "Rounded & Soft"
          ),
          designInteractions: enumOr(
            "design_interactions",
            GITPAGE_DESIGN_INTERACTIONS,
            "Energetic"
          ),
          designButtons: enumOr(
            "design_buttons",
            GITPAGE_DESIGN_BUTTONS,
            "Solid Primary"
          ),
          designContactForm: enumOr(
            "design_contact_form",
            GITPAGE_DESIGN_CONTACT_FORM,
            "Centered Card"
          ),
          designIcons: enumOr(
            "design_icons",
            GITPAGE_DESIGN_ICONS,
            "Heroicons Outline"
          ),
          includeServicesPage:
            (raw as Record<string, unknown>)?.include_services_page !== false,
          includeContactPage: wantsContactPage,
          includePrivacyPage:
            (raw as Record<string, unknown>)?.include_privacy_page === true,
          includeTermsPage:
            (raw as Record<string, unknown>)?.include_terms_page === true,
          servicesList: str(raw, "services_list").slice(0, 600),
          videoLink,
          business,
        },
      };
    },
    summarize: (args) => {
      const nicheLabel =
        args.niche === "gym_fitness"
          ? "Gym & Fitness template"
          : args.niche === "home_services"
            ? "Home Services template"
            : args.niche === "real_estate"
              ? "Real Estate template"
              : args.niche === "agency_consulting"
                ? "Agency & Consulting template"
                : "generic design";
      const kind =
        args.buildType === "vsl"
          ? "single-page video funnel"
          : `multi-page site (${nicheLabel})`;
      const premium = args.quality === "premium";
      const wiring = premium
        ? ` Premium build${args.concept ? ` (direction: ${args.concept})` : ""}${args.includeForm ? ", contact form wired to this workspace" : ""}${args.includeChat ? ", AI chat widget on every page" : ""}.`
        : " Standard (quick template) build.";
      return `Create & BUILD the website “${
        args.siteName || args.heading
      }” — ${kind}, ${args.colorScheme === "Dark Mode" ? "dark mode" : "standard colours"}, heading “${args.heading}”.${wiring} This submits a real build (uses one of your agency's website builds; live in ~${premium ? "10–20" : "1–3"} minutes).`;
    },
    execute: async (ctx, args) => {
      const subAccountId = ctx.subAccountId!;
      const db = getAdminDb();

      // Contact email and CTA come from the workspace's saved details, never model guesses.
      const [subSnap, profileSnap] = await Promise.all([
        db.doc(`subAccounts/${subAccountId}`).get(),
        db.doc(`subAccounts/${subAccountId}/aiAgent/profile`).get(),
      ]);
      const sub = (subSnap.data() ?? {}) as Record<string, unknown>;
      const accountContact = (sub.accountContact ?? {}) as {
        email?: string | null;
        phone?: string | null;
      };
      const profileBusinessName =
        (profileSnap.data()?.businessName as string | undefined) ?? "";

      const business = args.business as Record<string, string>;
      const contactEmail =
        (args.contactEmail as string) ||
        business.email ||
        accountContact.email ||
        "";
      if (!contactEmail) {
        throw new CapabilityUserError(
          "I need a public contact email for the site. Tell me which to use, or save one under Settings → Account contact first."
        );
      }
      const bookingLink =
        typeof sub.bookingLink === "string" &&
        /^https?:\/\//i.test(sub.bookingLink)
          ? sub.bookingLink
          : "";
      const ctaLink = (args.ctaLink as string) || bookingLink;
      if (!ctaLink) {
        throw new CapabilityUserError(
          "I need a link for the site's main button (a booking page or your website). Tell me the URL, or set a booking link in Settings first."
        );
      }

      const buildType = args.buildType as "local" | "vsl";
      const niche = args.niche as Niche | null;
      const config: WebsiteConfig =
        buildType === "vsl" ? blankVslConfig() : blankWebsiteConfig();

      config.build_type = buildType;
      config.niche = niche;
      config.language = args.language as string;
      config.heading = args.heading as string;
      config.color_scheme = args.colorScheme as WebsiteConfig["color_scheme"];
      config.hero_statement = args.heroStatement as string;
      config.features = args.features as string;
      config.benefits = args.benefits as string;
      config.contact_details = contactEmail;
      config.cta_link = ctaLink;
      config.include_faq = args.includeFaq as boolean;
      config.video_link = (args.videoLink as string) || "";
      config.design_color_palette = args.designPalette as string;
      config.custom_colors = args.customColors as string;
      config.design_typography = args.designTypography as string;
      config.design_layout = args.designLayout as string;
      config.design_components = args.designComponents as string;
      config.design_interactions = args.designInteractions as string;
      config.design_buttons = args.designButtons as string;
      config.design_contact_form = args.designContactForm as string;
      config.design_icons = args.designIcons as string;
      config.quality = args.quality as WebsiteConfig["quality"];
      config.concept = (args.concept as string | null) ?? null;
      config.hero_motion = (args.heroMotion as WebsiteConfig["hero_motion"]) ?? null;
      config.include_form = args.includeForm as boolean;
      config.include_chat = args.includeChat as boolean;
      config.include_voice = args.includeVoice !== false;
      config.premium_details = (args.premiumDetails as WebsitePremiumDetails | null) ?? null;

      const needsBusinessDetails =
        buildType === "local" &&
        (niche !== null || (args.includeContactPage as boolean));
      if (buildType === "local") {
        config.local_page_selections = {
          index: true,
          services: (args.includeServicesPage as boolean) || niche !== null,
          contact: needsBusinessDetails,
          privacy: (args.includePrivacyPage as boolean) || niche !== null,
          terms: (args.includeTermsPage as boolean) || niche !== null,
        };
        const servicesList = args.servicesList as string;
        config.services_config = config.local_page_selections.services
          ? {
              let_ai_do_services: !servicesList,
              services_list: servicesList,
            }
          : null;
        config.business_details = needsBusinessDetails
          ? {
              ...blankBusinessDetails(),
              business_name:
                business.name ||
                profileBusinessName ||
                (sub.name as string) ||
                "",
              business_street: business.street,
              business_city: business.city,
              business_state: business.state,
              business_country: business.country,
              business_zip: business.zip,
              business_phone: business.phone || accountContact.phone || "",
              business_email: business.email || contactEmail,
              opening_hours: business.opening_hours,
            }
          : null;
      }

      // Create the draft slot only once the config is valid, so a failure
      // never leaves a blank card behind.
      const { siteId } = await (async () => {
        try {
          return await createWebsiteForSubAccount({
            subAccountId,
            name:
              (args.siteName as string) ||
              business.name ||
              (args.heading as string),
          });
        } catch (err) {
          if (err instanceof WebsiteServiceError) {
            throw new CapabilityUserError(err.message);
          }
          throw err;
        }
      })();

      try {
        await submitWebsiteBuildForSubAccount({
          subAccountId,
          siteId,
          config,
          buildByUid: ctx.uid,
        });
      } catch (err) {
        // Don't let a failed submit hold one of the 5 site slots; the user will retry from chat.
        await db
          .doc(`subAccounts/${subAccountId}/website/${siteId}`)
          .delete()
          .catch(() => undefined);
        if (err instanceof WebsiteServiceError) {
          const firstFieldError = err.fieldErrors
            ? Object.values(err.fieldErrors)[0]
            : null;
          throw new CapabilityUserError(
            firstFieldError ? `${err.message} ${firstFieldError}` : err.message
          );
        }
        throw err;
      }

      const premiumBuild = args.quality === "premium";
      return {
        resultText: premiumBuild
          ? `The premium build for “${
              (args.siteName as string) || (args.heading as string)
            }” is submitted — it takes about 10–20 minutes (brief → photography → design → publish). When it goes live the site's contact form feeds this workspace, the AI chat widget is on every page with a knowledge base seeded from the site, and a speed-to-lead workflow is created on the form. Watch it under Sidebar → Website; the card shows the live URL and what was wired up. Use check_website_status to see progress.`
          : `The build for “${
              (args.siteName as string) || (args.heading as string)
            }” is submitted — it takes about 1–3 minutes to generate. Watch it go live under Sidebar → Website; the card shows the live URL when it's ready.`,
        ref: { kind: "website", id: siteId },
      };
    },
  },
  {
    name: "list_website_concepts",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    menuLabel: "Show the premium website design directions for a niche",
    description:
      "List the premium website design directions ('concepts') available for a niche — three studio-style options per niche (name, pitch, who it fits, light/dark). Use BEFORE create_website on a premium build so the user can pick one; pass the chosen id as `concept`. Omit niche for the generic (no-niche) directions.",
    parameters: {
      type: "object",
      properties: {
        niche: {
          type: "string",
          enum: ["gym_fitness", "home_services", "real_estate", "agency_consulting", "ai_consulting", "ai_automation", "none"],
          description: "The niche the site will use. 'none' = generic directions.",
        },
      },
      additionalProperties: false,
    },
    validate: (raw) => {
      const nicheRaw = str(raw, "niche");
      return { ok: true, args: { niche: isNicheKey(nicheRaw) ? nicheRaw : null } };
    },
    summarize: (args) => `List design directions for ${args.niche ?? "a generic site"}.`,
    execute: async (ctx, args) => {
      // Website gate is per sub-account.
      const subSnap = await getAdminDb().doc(`subAccounts/${ctx.subAccountId!}`).get();
      if (subSnap.data()?.websiteEnabledByAgency !== true) {
        throw new CapabilityUserError(
          "The website builder is disabled for this workspace — ask the agency owner to enable it from Agency → Sub-accounts → Manage."
        );
      }
      if (!gitpageIsConfigured()) {
        throw new CapabilityUserError(
          "The website builder isn't configured on this deployment (GITPAGE_API_KEY is missing)."
        );
      }
      try {
        const cards = await fetchConcepts(args.niche as string | null);
        if (!cards.length) {
          return { resultText: "gitpage returned no design directions for that niche — build without a concept and gitpage will pick its default." };
        }
        const lines = cards.map(
          (c) =>
            `- ${c.name} (id: ${c.id}; ${c.archetype} layout, ${c.defaultMode} by default, hero: ${c.heroMotion}) — ${c.pitch}${c.fit ? ` Fits: ${c.fit}` : ""}`
        );
        return {
          resultText: `Design directions for ${args.niche ?? "a generic site"}:\n${lines.join("\n")}\nPass the chosen id as \`concept\` to create_website, or omit it to let gitpage choose.`,
        };
      } catch (err) {
        if (err instanceof GitpageError) {
          throw new CapabilityUserError(`gitpage couldn't list concepts: ${err.message}`);
        }
        throw err;
      }
    },
  },
  {
    name: "check_website_status",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    menuLabel: "Check this workspace's websites (build status + live URLs)",
    description:
      "List this sub-account's websites with their build status and live URL. Use when the user asks whether their site is done, what sites exist, or for a site's address.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "Check the websites' status.",
    execute: async (ctx) => {
      const snap = await getAdminDb()
        .collection(`subAccounts/${ctx.subAccountId!}/website`)
        .get();
      if (snap.empty) {
        return {
          resultText:
            "No websites exist in this workspace yet. Ask me to build one, or use Sidebar → Website.",
        };
      }
      const lines = snap.docs.map((d) => {
        const w = d.data() as Record<string, unknown>;
        const name =
          (w.name as string) ||
          ((w.config as { heading?: string } | undefined)?.heading ??
            "Untitled site");
        const status = w.status as string;
        const cfg = (w.config ?? {}) as Partial<WebsiteConfig>;
        const premium = (w.quality ?? effectiveQuality(cfg)) === "premium";
        const phase = typeof w.statusPhase === "string" ? w.statusPhase : null;
        const detail =
          status === "ready" && w.liveUrl
            ? `live at ${typeof w.customDomain === "string" && w.customDomain ? `https://${w.customDomain}/ (custom domain; gitpage address ${w.liveUrl})` : w.liveUrl}`
            : status === "failed"
              ? `failed${w.errorMessage ? ` — ${w.errorMessage}` : ""}`
              : status === "queued" || status === "building"
                ? premium
                  ? `building now (premium — usually 10–20 minutes${phase ? `, currently: ${phase.replace(/_/g, " ")}` : ""})`
                  : "building now (usually 1–3 minutes)"
                : "draft (not built yet)";
        const cta = cfg.cta_link?.trim() || "";
        const prov = (w.provisioning ?? null) as WebsiteProvisioning | null;
        const wiring = prov
          ? ` Wired on publish: ${[
              prov.formId ? "contact form feeds this workspace" : "no contact form",
              prov.chatEnabled
                ? `AI chat live on ${prov.hostname ?? "the site"}${prov.kbSeeded ? " (KB seeded)" : ""}`
                : prov.chatSkippedReason
                  ? `chat widget present but bot off (${prov.chatSkippedReason})`
                  : "no chat",
              ...(prov.voiceEnabled ? ["voice (talk to the chat) on"] : []),
              prov.workflowId
                ? `speed-to-lead workflow ${prov.workflowStatus === "active" ? "published" : "saved as DRAFT"} (${prov.workflowId})`
                : "no speed-to-lead workflow",
            ].join("; ")}${prov.errors.length ? `; issues: ${prov.errors.join(" / ")}` : ""}.`
          : "";
        return `- “${name}” (${premium ? "premium" : "standard"}): ${detail}; call-to-action link: ${cta || "none set"}; id: ${d.id}.${wiring}${status === "ready" ? ` To edit it: the site card's Edit site button gives a copy-ready prompt for Claude with the GitPage connector${typeof w.gitpagePageId === "string" ? ` (GitPage pageId ${w.gitpagePageId})` : ""}${typeof w.editorEmail === "string" ? `; ${w.editorEmail} was invited as an editor on gitpage` : ""}.` : ""}`;
      });
      return {
        resultText: `Websites in this workspace:\n${lines.join("\n")}\n(To point a site's call-to-action at a form or booking page, use update_website_cta — it rebuilds the site.)`,
      };
    },
  },

  // Sub-account level, continued
  {
    name: "update_contact",
    level: "sub-account",
    requiredRole: "subAccountMember",
    menuLabel: "Update a contact — add or remove tags, fix details, add a note",
    description:
      "Update an existing contact in this sub-account: add/remove tags, correct name/email/phone/company/address, and/or append a note to their timeline. Resolve the contact's id with find_contacts first — never guess ids. Tags are free text (e.g. 'hot-lead'); adding an existing tag is a no-op. Use this for 'tag X as…', 'change X's phone to…', 'add a note to X saying…'.",
    parameters: {
      type: "object",
      properties: {
        contactId: {
          type: "string",
          description: "The contact's id, exactly as returned by find_contacts.",
        },
        contactName: {
          type: "string",
          description: "The contact's name, for the confirmation card.",
        },
        addTags: {
          type: "array",
          items: { type: "string" },
          description: "Tags to add.",
        },
        removeTags: {
          type: "array",
          items: { type: "string" },
          description: "Tags to remove (case-insensitive match).",
        },
        name: { type: "string", description: "New full name." },
        email: { type: "string", description: "New email address." },
        phone: { type: "string", description: "New phone number." },
        company: { type: "string", description: "New company name." },
        address: { type: "string", description: "New address." },
        note: {
          type: "string",
          description:
            "A note to append to the contact's timeline (plain text, ≤2000 chars).",
        },
      },
      required: ["contactId", "contactName"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const contactId = str(raw, "contactId");
      if (!contactId) {
        return {
          ok: false,
          error:
            "the contact id is required — I need to find the contact first (find_contacts)",
        };
      }
      const email = str(raw, "email");
      if (email && !EMAIL_RE.test(email)) {
        return { ok: false, error: "that email address doesn't look valid" };
      }
      const note = str(raw, "note").slice(0, 2000);
      const args = {
        contactId,
        contactName: str(raw, "contactName"),
        addTags: strList(raw, "addTags"),
        removeTags: strList(raw, "removeTags"),
        name: str(raw, "name"),
        email,
        phone: str(raw, "phone"),
        company: str(raw, "company"),
        address: str(raw, "address"),
        note,
      };
      const hasChange =
        args.addTags.length > 0 ||
        args.removeTags.length > 0 ||
        !!args.name ||
        !!args.email ||
        !!args.phone ||
        !!args.company ||
        !!args.address ||
        !!args.note;
      if (!hasChange) {
        return {
          ok: false,
          error:
            "nothing to change — give at least one of: tags to add/remove, a field to update, or a note",
        };
      }
      return { ok: true, args };
    },
    summarize: (args) => {
      const parts: string[] = [];
      const add = args.addTags as string[];
      const rm = args.removeTags as string[];
      if (add.length) parts.push(`add tag${add.length > 1 ? "s" : ""} ${add.map((t) => `“${t}”`).join(", ")}`);
      if (rm.length) parts.push(`remove tag${rm.length > 1 ? "s" : ""} ${rm.map((t) => `“${t}”`).join(", ")}`);
      for (const f of ["name", "email", "phone", "company", "address"] as const) {
        if (args[f]) parts.push(`set ${f} to “${args[f]}”`);
      }
      if (args.note) parts.push("add a note");
      return `Update ${args.contactName || args.contactId}: ${parts.join("; ")}.`;
    },
    execute: async (ctx, args) => {
      const db = getAdminDb();
      const snap = await db.doc(`contacts/${args.contactId as string}`).get();
      if (!snap.exists || snap.data()?.subAccountId !== ctx.subAccountId) {
        throw new CapabilityUserError(
          "That contact wasn't found in this workspace."
        );
      }
      const existing = snap.data()!;
      const name = (existing.name as string) || (args.contactName as string);
      const patch: Parameters<typeof updateContactServerSide>[0]["patch"] = {};
      const add = args.addTags as string[];
      const rm = args.removeTags as string[];
      const changes: string[] = [];
      if (add.length || rm.length) {
        const current: string[] = Array.isArray(existing.tags)
          ? (existing.tags as unknown[]).filter(
              (t): t is string => typeof t === "string"
            )
          : [];
        const rmSet = new Set(rm.map((t) => t.toLowerCase()));
        let next = current.filter((t) => !rmSet.has(t.toLowerCase()));
        const removed = current.length - next.length;
        const added: string[] = [];
        for (const t of add) {
          if (!next.some((n) => n.toLowerCase() === t.toLowerCase())) {
            next = [...next, t];
            added.push(t);
          }
        }
        if (added.length || removed) {
          patch.tags = next;
          if (added.length) changes.push(`added ${added.map((t) => `“${t}”`).join(", ")}`);
          if (removed) changes.push(`removed ${removed} tag${removed > 1 ? "s" : ""}`);
        } else {
          changes.push("tags already as requested");
        }
      }
      for (const f of ["name", "email", "phone", "company", "address"] as const) {
        const v = args[f] as string;
        if (v) {
          patch[f] = v;
          changes.push(`${f} → “${v}”`);
        }
      }
      if (Object.keys(patch).length > 0) {
        await updateContactServerSide({ contactId: snap.id, patch });
      }
      if (args.note) {
        await db.collection(`contacts/${snap.id}/notes`).add({
          content: args.note as string,
          createdBy: ctx.uid,
          createdAt: FieldValue.serverTimestamp(),
        });
        changes.push("note added");
      }
      return {
        resultText: `Updated ${name}: ${changes.join("; ")}.`,
        ref: { kind: "contact", id: snap.id },
      };
    },
  },
  {
    name: "list_workflows",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    menuLabel: "See your workflows and whether each is live, paused, or a draft",
    description:
      "List this workspace's automation workflows with their status (draft / active / paused), trigger, and id — plus whether the workspace-wide 'Pause all workflows' switch is on. Use to answer 'which automations are running?' and ALWAYS to resolve a workflow's id before set_workflow_status — never guess ids.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "List workflows.",
    execute: async (ctx) => {
      const [rows, subSnap] = await Promise.all([
        listWorkflows(ctx.subAccountId!),
        getAdminDb().doc(`subAccounts/${ctx.subAccountId!}`).get(),
      ]);
      const pausedAll = subSnap.data()?.automationsPaused === true;
      const pauseLine = pausedAll
        ? "⚠️ 'Pause all workflows' is ON for this workspace — no triggers fire until it's resumed (Settings → Messaging → Sending preferences, or ask me to resume)."
        : "'Pause all workflows' is off.";
      if (rows.length === 0) {
        return {
          resultText: `No workflows yet — create one from a starter template on the Workflows page (or ask me to). ${pauseLine}`,
        };
      }
      const lines = rows.slice(0, 30).map((w) => {
        const trig = w.trigger?.type ?? "no trigger";
        const empty = !w.startNodeId ? ", no steps yet" : "";
        return `- ${w.name} — ${w.status}${empty}, trigger: ${trig}, id: ${w.id}`;
      });
      const more =
        rows.length > 30 ? `\n(+${rows.length - 30} more — see the Workflows page)` : "";
      return {
        resultText: `Workflows (${rows.length}):\n${lines.join("\n")}${more}\n${pauseLine}`,
      };
    },
  },
  {
    name: "set_workflow_status",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    menuLabel: "Publish, pause, or unpublish a workflow",
    description:
      "Change one workflow's status: 'active' publishes it (triggers start enrolling contacts), 'paused' stops new enrollments while keeping it configured, 'draft' unpublishes it. Resolve the workflow's id with list_workflows first — never guess ids. A workflow with no steps can't be published.",
    parameters: {
      type: "object",
      properties: {
        workflowId: {
          type: "string",
          description: "The workflow's id, exactly as returned by list_workflows.",
        },
        workflowName: {
          type: "string",
          description: "The workflow's name, for the confirmation card.",
        },
        status: {
          type: "string",
          enum: ["active", "paused", "draft"],
          description: "The new status.",
        },
      },
      required: ["workflowId", "workflowName", "status"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const workflowId = str(raw, "workflowId");
      if (!workflowId) {
        return {
          ok: false,
          error:
            "the workflow id is required — I need to look it up first (list_workflows)",
        };
      }
      const status = str(raw, "status");
      if (!["active", "paused", "draft"].includes(status)) {
        return { ok: false, error: "status must be active, paused, or draft" };
      }
      return {
        ok: true,
        args: { workflowId, workflowName: str(raw, "workflowName"), status },
      };
    },
    summarize: (args) => {
      const verb =
        args.status === "active"
          ? "Publish"
          : args.status === "paused"
            ? "Pause"
            : "Unpublish (set to draft)";
      return `${verb} the workflow “${args.workflowName || args.workflowId}”.`;
    },
    execute: async (ctx, args) => {
      const wf = await getWorkflow(ctx.subAccountId!, args.workflowId as string);
      if (!wf) {
        throw new CapabilityUserError(
          "That workflow wasn't found in this workspace."
        );
      }
      const status = args.status as "active" | "paused" | "draft";
      if (wf.status === status) {
        return {
          resultText: `“${wf.name}” is already ${status} — nothing to change.`,
          ref: { kind: "workflow", id: wf.id },
        };
      }
      if (status === "active" && !wf.startNodeId) {
        throw new CapabilityUserError(
          `“${wf.name}” has no steps yet, so it can't be published — add at least one step in the workflow editor first.`
        );
      }
      if (status === "active") {
        const block = await aiSmsActivationBlock(ctx.subAccountId!, wf.nodes);
        if (block) throw new CapabilityUserError(block);
      }
      const ok = await updateWorkflowServerSide({
        subAccountId: ctx.subAccountId!,
        workflowId: wf.id,
        patch: { status },
      });
      if (!ok) {
        throw new CapabilityUserError("That workflow couldn't be updated.");
      }
      const note =
        status === "active"
          ? " It will now enroll contacts when its trigger fires."
          : status === "paused"
            ? " No new contacts will enroll until it's published again; runs already in progress continue."
            : " It's back to a draft — no trigger fires until you publish it.";
      return {
        resultText: `“${wf.name}” is now ${status}.${note}`,
        ref: { kind: "workflow", id: wf.id },
      };
    },
  },
  {
    name: "pause_all_workflows",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    menuLabel: "Pause (or resume) every workflow in the workspace — the emergency stop",
    description:
      "Flip the workspace-wide 'Pause all workflows' switch. paused=true is the emergency stop: no workflow triggers fire and in-flight runs stop at their next step. paused=false resumes. Use for 'stop all automations now' / 'resume automations'. Check the current state with list_workflows first.",
    parameters: {
      type: "object",
      properties: {
        paused: {
          type: "boolean",
          description: "true to pause everything, false to resume.",
        },
      },
      required: ["paused"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const paused = bool(raw, "paused");
      if (paused === null) {
        return { ok: false, error: "paused must be true or false" };
      }
      return { ok: true, args: { paused } };
    },
    summarize: (args) =>
      args.paused
        ? "PAUSE ALL workflows in this workspace — no triggers fire and in-flight runs stop at their next step until resumed."
        : "Resume all workflows in this workspace.",
    execute: async (ctx, args) => {
      const ref = getAdminDb().doc(`subAccounts/${ctx.subAccountId!}`);
      const snap = await ref.get();
      if (!snap.exists) {
        throw new CapabilityUserError("This workspace wasn't found.");
      }
      const current = snap.data()?.automationsPaused === true;
      const paused = args.paused as boolean;
      if (current === paused) {
        return {
          resultText: paused
            ? "Workflows were already paused — nothing to change."
            : "Workflows weren't paused — nothing to change.",
        };
      }
      await ref.update({
        automationsPaused: paused,
        updatedAt: FieldValue.serverTimestamp(),
      });
      return {
        resultText: paused
          ? "All workflows are paused. Nothing will send until you resume (ask me, or use Settings → Messaging → Sending preferences)."
          : "Workflows resumed — triggers fire again and waiting runs continue at their next step.",
        ref: { kind: "subAccount", id: ctx.subAccountId! },
      };
    },
  },
  {
    name: "list_pipelines",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    menuLabel: "See your pipelines and their stages",
    description:
      "List this workspace's pipelines with each one's ordered stages (stage ids, labels, and which are the Won / Lost stages). Use to answer 'what pipelines / stages do we have?' and to resolve stage ids before create_deal / move_deal_stage / find_deals.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "List pipelines.",
    execute: async (ctx) => {
      const pipelines = await loadResolvedPipelines(ctx.subAccountId!);
      const blocks = pipelines.map((p) => {
        const stages = p.stages
          .map(
            (s) =>
              `${s.label} (${s.id})${
                s.terminal === "won" ? " [Won]" : s.terminal === "lost" ? " [Lost]" : ""
              }`
          )
          .join(" → ");
        return `- ${p.name} — id: ${p.id}${p.id === "default" ? " (default)" : ""}\n  ${stages}`;
      });
      return {
        resultText: `Pipelines (${pipelines.length}):\n${blocks.join("\n")}\nAdmins can add pipelines under Settings → Admin → Pipelines (or ask me to create one).`,
      };
    },
  },
  {
    name: "create_pipeline",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    menuLabel: "Create a new pipeline with custom stages",
    description:
      "Create an additional pipeline (e.g. 'Fulfillment', 'Recruiting') with its own ordered stages — 2 to 12 stages, and EXACTLY one must be marked outcome 'won' and one 'lost' (rename them freely, e.g. 'Delivered' as the won stage and 'Cancelled' as the lost stage). If the user doesn't say, propose sensible stages and ask before proposing. Max 10 pipelines per workspace. Check list_pipelines first so you don't duplicate one.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Pipeline name (1–40 chars)." },
        stages: {
          type: "array",
          minItems: 2,
          maxItems: 12,
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "Stage name (1–30 chars)." },
              outcome: {
                type: "string",
                enum: ["won", "lost"],
                description:
                  "Mark the single closing-success stage 'won' and the single closing-failure stage 'lost'; omit for every other stage.",
              },
            },
            required: ["label"],
            additionalProperties: false,
          },
          description: "Ordered stages, first to last.",
        },
      },
      required: ["name", "stages"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const name = str(raw, "name");
      if (!name || name.length > 40) {
        return { ok: false, error: "the pipeline name must be 1–40 characters" };
      }
      const rawStages = (raw as Record<string, unknown>)?.stages;
      if (!Array.isArray(rawStages) || rawStages.length < 2 || rawStages.length > 12) {
        return { ok: false, error: "give 2 to 12 stages, in order" };
      }
      const stages: { label: string; terminal?: "won" | "lost" }[] = [];
      let won = 0;
      let lost = 0;
      for (const s of rawStages) {
        const label = str(s, "label");
        if (!label || label.length > 30) {
          return { ok: false, error: "every stage needs a 1–30 character name" };
        }
        const outcome = str(s, "outcome");
        if (outcome === "won") won++;
        if (outcome === "lost") lost++;
        stages.push(
          outcome === "won" || outcome === "lost"
            ? { label, terminal: outcome }
            : { label }
        );
      }
      if (won !== 1 || lost !== 1) {
        return {
          ok: false,
          error:
            "exactly one stage must be marked outcome 'won' and exactly one 'lost' (the closing stages)",
        };
      }
      return { ok: true, args: { name, stages } };
    },
    summarize: (args) => {
      const stages = args.stages as { label: string; terminal?: string }[];
      return `Create the pipeline “${args.name}” with stages: ${stages
        .map((s) => `${s.label}${s.terminal ? ` [${s.terminal}]` : ""}`)
        .join(" → ")}.`;
    },
    execute: async (ctx, args) => {
      try {
        const doc = await createPipeline(ctx.subAccountId!, {
          name: args.name as string,
          stages: args.stages,
        });
        return {
          resultText: `Created the “${doc.name}” pipeline (id: ${doc.id}) with ${doc.stages.length} stages. It shows as a tab on the Pipeline page; new deals can be created in it and existing deals moved into it from their edit panel.`,
          ref: { kind: "pipeline", id: doc.id },
        };
      } catch (err) {
        if (err instanceof PipelineError) {
          throw new CapabilityUserError(err.message);
        }
        throw err;
      }
    },
  },
  {
    name: "find_quotes",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    menuLabel: "See quotes and invoices — e.g. what's still unpaid",
    description:
      "List this workspace's quotes and/or invoices with number, contact, total, status, and id. filter: 'unpaid' = sent/viewed/accepted but not yet paid (the money-owed view); 'open' = anything not paid, declined, or expired; 'all'. Use for 'which invoices are outstanding?', 'did Acme pay?', and ALWAYS to resolve an id before mark_quote_paid — never guess ids.",
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["quote", "invoice", "all"],
          description: "Which documents; default all.",
        },
        filter: {
          type: "string",
          enum: ["unpaid", "open", "all"],
          description: "Default 'open'.",
        },
        contactName: {
          type: "string",
          description: "Optional — only documents whose contact name contains this.",
        },
      },
      additionalProperties: false,
    },
    validate: (raw) => {
      const kind = str(raw, "kind") || "all";
      const filter = str(raw, "filter") || "open";
      if (!["quote", "invoice", "all"].includes(kind)) {
        return { ok: false, error: "kind must be quote, invoice, or all" };
      }
      if (!["unpaid", "open", "all"].includes(filter)) {
        return { ok: false, error: "filter must be unpaid, open, or all" };
      }
      return {
        ok: true,
        args: { kind, filter, contactName: str(raw, "contactName").toLowerCase() },
      };
    },
    summarize: (args) => `List ${args.filter} ${args.kind === "all" ? "quotes and invoices" : `${args.kind}s`}.`,
    execute: async (ctx, args) => {
      const snap = await getAdminDb()
        .collection("quotes")
        .where("subAccountId", "==", ctx.subAccountId!)
        .limit(400)
        .get();
      type Row = {
        id: string;
        number: string;
        kind: "quote" | "invoice";
        status: string;
        contactId: string;
        total: number;
        currency: string;
        updated: number;
      };
      const rows: Row[] = snap.docs.map((d) => {
        const q = d.data() as Quote;
        const totals = computeQuoteTotals({
          lineItems: Array.isArray(q.lineItems) ? q.lineItems : [],
          globalDiscount: q.globalDiscount ?? null,
          globalTaxPercent: q.globalTaxPercent ?? null,
        });
        return {
          id: d.id,
          number: q.quoteNumber || d.id,
          kind: q.kind === "invoice" ? "invoice" : "quote",
          status: effectiveQuoteStatus({
            status: q.status,
            validUntil: q.validUntil ?? null,
          }),
          contactId: q.contactId,
          total: totals.total,
          currency: q.currency || "USD",
          updated: toDate(q.updatedAt)?.getTime() ?? 0,
        };
      });
      const unpaidStatuses = new Set(["sent", "viewed", "accepted"]);
      const closed = new Set(["paid", "declined", "expired"]);
      let wanted = rows.filter((r) =>
        args.kind === "all" ? true : r.kind === args.kind
      );
      if (args.filter === "unpaid") {
        wanted = wanted.filter((r) => unpaidStatuses.has(r.status));
      } else if (args.filter === "open") {
        wanted = wanted.filter((r) => !closed.has(r.status));
      }
      const names = await contactNamesById(
        ctx.subAccountId!,
        wanted.map((r) => r.contactId)
      );
      if (args.contactName) {
        wanted = wanted.filter((r) =>
          (names.get(r.contactId) ?? "").toLowerCase().includes(args.contactName as string)
        );
      }
      if (wanted.length === 0) {
        return {
          resultText: `No ${args.filter} ${args.kind === "all" ? "quotes or invoices" : `${args.kind}s`}${args.contactName ? ` for “${args.contactName}”` : ""}.`,
        };
      }
      wanted.sort((a, b) => b.updated - a.updated);
      const shown = wanted.slice(0, 20);
      const lines = shown.map(
        (r) =>
          `- ${r.number} (${r.kind}) — ${names.get(r.contactId) ?? "unknown contact"}, ${fmtMoney(r.total, r.currency)}, ${r.status}, id: ${r.id}`
      );
      const owed = wanted
        .filter((r) => unpaidStatuses.has(r.status))
        .reduce<Record<string, number>>((acc, r) => {
          acc[r.currency] = (acc[r.currency] ?? 0) + r.total;
          return acc;
        }, {});
      const owedLine = Object.keys(owed).length
        ? `\nOutstanding (sent/viewed/accepted, not paid): ${Object.entries(owed)
            .map(([c, v]) => fmtMoney(v, c))
            .join(", ")}`
        : "";
      const more =
        wanted.length > shown.length
          ? `\n(+${wanted.length - shown.length} more — see the Quotes page)`
          : "";
      const filterLabel = args.filter as string;
      return {
        resultText: `${filterLabel === "all" ? "Quotes & invoices" : `${filterLabel[0]!.toUpperCase()}${filterLabel.slice(1)} documents`} (${wanted.length}):\n${lines.join("\n")}${more}${owedLine}`,
      };
    },
  },
  {
    name: "mark_quote_paid",
    level: "sub-account",
    requiredRole: "subAccountMember",
    menuLabel: "Mark a quote or invoice as paid",
    description:
      "Mark a quote or invoice as paid — for money that arrived outside the app (bank transfer, PayPal, cash). Resolve the id with find_quotes first — never guess ids. Card payments through the connected Stripe mark themselves paid automatically, so only use this when the user confirms payment landed elsewhere. Fires the same 'quote paid' workflow trigger, activity entry, and (if enabled) Google review request as the Mark paid button.",
    parameters: {
      type: "object",
      properties: {
        quoteId: {
          type: "string",
          description: "The document's id, exactly as returned by find_quotes.",
        },
        quoteNumber: {
          type: "string",
          description: "Its number (e.g. INV-2026-0003), for the confirmation card.",
        },
      },
      required: ["quoteId", "quoteNumber"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const quoteId = str(raw, "quoteId");
      if (!quoteId) {
        return {
          ok: false,
          error: "the quote/invoice id is required — I need to find it first (find_quotes)",
        };
      }
      return { ok: true, args: { quoteId, quoteNumber: str(raw, "quoteNumber") } };
    },
    summarize: (args) => `Mark ${args.quoteNumber || args.quoteId} as PAID.`,
    execute: async (ctx, args) => {
      const outcome = await markQuotePaidServerSide({
        quoteId: args.quoteId as string,
        expectSubAccountId: ctx.subAccountId!,
      });
      if (!outcome.ok) {
        if (outcome.code === "not_found" || outcome.code === "wrong_tenant") {
          throw new CapabilityUserError(
            "That quote or invoice wasn't found in this workspace."
          );
        }
        if (outcome.code === "already_paid") {
          return {
            resultText: `${args.quoteNumber || args.quoteId} is already marked paid — nothing to change.`,
          };
        }
        throw new CapabilityUserError(outcome.message);
      }
      return {
        resultText: `Marked ${outcome.quote.quoteNumber} as paid. The contact's timeline and any 'quote paid' workflows have been updated.`,
        ref: { kind: "quote", id: outcome.quote.id },
      };
    },
  },
  {
    name: "find_awaiting_payment_bookings",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    menuLabel: "See bookings still waiting on a deposit",
    description:
      "List this workspace's booking-page appointments that are 'awaiting payment' (a deposit was required and hasn't been confirmed). Use for 'who still needs to pay their deposit?' and ALWAYS to resolve the event id before mark_booking_paid — never guess ids.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "List bookings awaiting payment.",
    execute: async (ctx) => {
      const tz = await subAccountTimezone(ctx.subAccountId!);
      const snap = await getAdminDb()
        .collection("events")
        .where("subAccountId", "==", ctx.subAccountId!)
        .where("status", "==", "awaiting_payment")
        .limit(100)
        .get();
      if (snap.empty) {
        return { resultText: "No bookings are waiting on a deposit." };
      }
      const rows = snap.docs.map((d) => {
        const e = d.data() as CalendarEvent;
        return {
          id: d.id,
          title: e.title || "(untitled)",
          start: toDate(e.startAt),
          contactId: typeof e.contactId === "string" ? e.contactId : null,
          page: e.bookingPageSlug ?? null,
        };
      });
      rows.sort((a, b) => (a.start?.getTime() ?? 0) - (b.start?.getTime() ?? 0));
      const names = await contactNamesById(
        ctx.subAccountId!,
        rows.map((r) => r.contactId)
      );
      const lines = rows.slice(0, 20).map(
        (r) =>
          `- ${r.title} — ${r.start ? fmtInTz(r.start, tz) : "no time"}${
            r.contactId ? `, ${names.get(r.contactId) ?? r.contactId}` : ""
          }${r.page ? `, page: ${r.page}` : ""}, id: ${r.id}`
      );
      return {
        resultText: `Bookings awaiting payment (${rows.length}, times in ${tz}):\n${lines.join("\n")}`,
      };
    },
  },
  {
    name: "mark_booking_paid",
    level: "sub-account",
    requiredRole: "subAccountMember",
    menuLabel: "Confirm a booking's deposit was paid",
    description:
      "Mark an 'awaiting payment' booking as paid, which confirms the appointment (it becomes scheduled, the hold stops expiring, and the confirmation email goes out). Resolve the event id with find_awaiting_payment_bookings first — never guess ids. Only for payments that arrived outside the app (e.g. PayPal, bank transfer) — card deposits via Stripe confirm themselves.",
    parameters: {
      type: "object",
      properties: {
        eventId: {
          type: "string",
          description: "The booking's event id, exactly as returned by find_awaiting_payment_bookings.",
        },
        label: {
          type: "string",
          description: "Who/when, for the confirmation card (e.g. 'Sam Lee, Tue 3pm').",
        },
      },
      required: ["eventId", "label"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const eventId = str(raw, "eventId");
      if (!eventId) {
        return {
          ok: false,
          error:
            "the booking's event id is required — I need to find it first (find_awaiting_payment_bookings)",
        };
      }
      return { ok: true, args: { eventId, label: str(raw, "label") } };
    },
    summarize: (args) =>
      `Mark the booking “${args.label || args.eventId}” as PAID and confirm the appointment.`,
    execute: async (ctx, args) => {
      const outcome = await markBookingPaidServerSide({
        eventId: args.eventId as string,
        expectSubAccountId: ctx.subAccountId!,
        paidByUid: ctx.uid,
      });
      if (!outcome.ok) {
        if (outcome.code === "not_found" || outcome.code === "wrong_tenant") {
          throw new CapabilityUserError(
            "That booking wasn't found in this workspace."
          );
        }
        throw new CapabilityUserError(outcome.message);
      }
      return {
        resultText: `Deposit confirmed — the booking “${args.label || args.eventId}” is now scheduled and the customer's confirmation has been sent. Their page: ${outcome.publicEventUrl}`,
        ref: { kind: "event", id: args.eventId as string },
      };
    },
  },
  {
    name: "list_communities",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    menuLabel: "See your community groups and the courses in each",
    description:
      "List this workspace's community groups (name, slug, status, id) and the courses inside each (title, published?, id). Use to answer 'what communities/courses do we have?' and ALWAYS to resolve group and course ids before add_course / add_lesson — never guess ids.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "List communities and courses.",
    execute: async (ctx) => {
      const db = getAdminDb();
      const groupsSnap = await db
        .collection(`subAccounts/${ctx.subAccountId!}/communityGroups`)
        .limit(20)
        .get();
      if (groupsSnap.empty) {
        return {
          resultText:
            "No community groups yet. Ask me to set one up, or create one under Sidebar → Community.",
        };
      }
      const blocks: string[] = [];
      for (const g of groupsSnap.docs) {
        const data = g.data();
        const coursesSnap = await db
          .collection(`subAccounts/${ctx.subAccountId!}/communityGroups/${g.id}/courses`)
          .limit(30)
          .get();
        const courses = coursesSnap.docs
          .map((c) => ({
            id: c.id,
            title: (c.data().title as string) || "(untitled)",
            published: c.data().published === true,
            order: typeof c.data().order === "number" ? (c.data().order as number) : 0,
          }))
          .sort((a, b) => a.order - b.order);
        const courseLines = courses.length
          ? courses
              .map((c) => `    • ${c.title}${c.published ? "" : " (unpublished)"} — course id: ${c.id}`)
              .join("\n")
          : "    (no courses yet)";
        blocks.push(
          `- ${(data.name as string) || "(unnamed)"} — ${data.status ?? "draft"}, ${data.mode === "courses" ? "courses only" : "full community"}, slug: ${data.slug ?? "?"}, group id: ${g.id}\n${courseLines}`
        );
      }
      return {
        resultText: `Communities (${groupsSnap.size}):\n${blocks.join("\n")}`,
      };
    },
  },
  {
    name: "add_course",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    menuLabel: "Add a course to an existing community",
    description:
      "Create a new course inside one of this workspace's community groups. Resolve the group's id with list_communities first — never guess ids. The course is created open to all members and published unless told otherwise; add lessons afterwards with add_lesson.",
    parameters: {
      type: "object",
      properties: {
        groupId: {
          type: "string",
          description: "The community group's id, exactly as returned by list_communities.",
        },
        groupName: { type: "string", description: "The group's name, for the confirmation card." },
        title: { type: "string", description: "Course title." },
        description: { type: "string", description: "Optional one-paragraph description." },
        published: {
          type: "boolean",
          description: "Publish immediately (default true). false keeps it hidden from members.",
        },
      },
      required: ["groupId", "groupName", "title"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const groupId = str(raw, "groupId");
      const title = str(raw, "title");
      if (!groupId) {
        return { ok: false, error: "the group id is required — look it up with list_communities first" };
      }
      if (!title) return { ok: false, error: "a course title is required" };
      return {
        ok: true,
        args: {
          groupId,
          groupName: str(raw, "groupName"),
          title,
          description: str(raw, "description").slice(0, 2000),
          published: bool(raw, "published") ?? true,
        },
      };
    },
    summarize: (args) =>
      `Add the course “${args.title}” to “${args.groupName || args.groupId}”${
        args.published ? " (published, open to all members)" : " (unpublished draft)"
      }.`,
    execute: async (ctx, args) => {
      const subSnap = await getAdminDb().doc(`subAccounts/${ctx.subAccountId!}`).get();
      if (subSnap.data()?.communityEnabledByAgency !== true) {
        throw new CapabilityUserError(
          "Community & Courses is disabled for this workspace. Your agency owner can enable it from the agency's sub-account Manage dialog."
        );
      }
      const group = await getGroupById(ctx.subAccountId!, args.groupId as string);
      if (!group) {
        throw new CapabilityUserError("That community group wasn't found in this workspace.");
      }
      const course = await createCourseServerSide({
        subAccountId: ctx.subAccountId!,
        agencyId: ctx.agencyId,
        groupId: group.id,
        title: args.title as string,
        description: (args.description as string) || undefined,
        published: args.published as boolean,
      });
      const base = process.env.NEXT_PUBLIC_APP_URL ?? "";
      return {
        resultText: `Added the course “${course.title}” (id: ${course.id}) to “${group.name}”${
          args.published ? "" : " as an unpublished draft"
        }. Classroom: ${base}/c/${ctx.subAccountId}/${group.slug}/classroom/${course.id} — add lessons with add_lesson or in the classroom editor.`,
        ref: { kind: "course", id: course.id },
      };
    },
  },
  {
    name: "add_lesson",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    menuLabel: "Add a lesson (with optional video) to a course",
    description:
      "Add a lesson to an existing course in a community group, optionally under a named section (created if it doesn't exist), with an optional YouTube/Vimeo video URL and plain-text body. Resolve the group and course ids with list_communities first — never guess ids. Published by default.",
    parameters: {
      type: "object",
      properties: {
        groupId: { type: "string", description: "Group id from list_communities." },
        courseId: { type: "string", description: "Course id from list_communities." },
        courseTitle: { type: "string", description: "Course title, for the confirmation card." },
        title: { type: "string", description: "Lesson title." },
        sectionTitle: {
          type: "string",
          description: "Optional section to file it under (matched by name; created if missing).",
        },
        videoUrl: { type: "string", description: "Optional YouTube or Vimeo URL." },
        text: { type: "string", description: "Optional lesson text (plain text; paragraphs on blank lines)." },
        published: { type: "boolean", description: "Publish immediately (default true)." },
      },
      required: ["groupId", "courseId", "courseTitle", "title"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const groupId = str(raw, "groupId");
      const courseId = str(raw, "courseId");
      const title = str(raw, "title");
      if (!groupId || !courseId) {
        return {
          ok: false,
          error: "the group id and course id are required — look them up with list_communities first",
        };
      }
      if (!title) return { ok: false, error: "a lesson title is required" };
      const videoUrl = str(raw, "videoUrl");
      if (videoUrl && !/^https?:\/\//i.test(videoUrl)) {
        return { ok: false, error: "the video URL must start with http(s)://" };
      }
      return {
        ok: true,
        args: {
          groupId,
          courseId,
          courseTitle: str(raw, "courseTitle"),
          title,
          sectionTitle: str(raw, "sectionTitle").slice(0, 80),
          videoUrl,
          text: str(raw, "text").slice(0, 20000),
          published: bool(raw, "published") ?? true,
        },
      };
    },
    summarize: (args) =>
      `Add the lesson “${args.title}”${args.sectionTitle ? ` (section “${args.sectionTitle}”)` : ""}${
        args.videoUrl ? " with video" : ""
      } to the course “${args.courseTitle || args.courseId}”${args.published ? "" : " as a draft"}.`,
    execute: async (ctx, args) => {
      const group = await getGroupById(ctx.subAccountId!, args.groupId as string);
      if (!group) {
        throw new CapabilityUserError("That community group wasn't found in this workspace.");
      }
      const tree = await getCourseTree({
        subAccountId: ctx.subAccountId!,
        groupId: group.id,
        courseId: args.courseId as string,
        includeUnpublished: true,
      });
      if (!tree) {
        throw new CapabilityUserError("That course wasn't found in this community.");
      }
      let sectionId: string | null = null;
      let sectionNote = "";
      const wantSection = args.sectionTitle as string;
      if (wantSection) {
        const match = tree.sections.find(
          (s) => s.title.trim().toLowerCase() === wantSection.toLowerCase()
        );
        if (match) {
          sectionId = match.id;
        } else {
          const created = await createSectionServerSide({
            subAccountId: ctx.subAccountId!,
            groupId: group.id,
            courseId: tree.course.id,
            title: wantSection,
          });
          sectionId = created.id;
          sectionNote = ` (new section “${created.title}” created)`;
        }
      } else if (tree.sections.length === 1) {
        sectionId = tree.sections[0]!.id;
      }
      const lesson = await createLessonServerSide({
        subAccountId: ctx.subAccountId!,
        groupId: group.id,
        courseId: tree.course.id,
        sectionId,
        title: args.title as string,
      });
      const { videoError } = await updateLessonServerSide({
        subAccountId: ctx.subAccountId!,
        groupId: group.id,
        courseId: tree.course.id,
        lessonId: lesson.id,
        patch: {
          published: args.published as boolean,
          videoUrl: (args.videoUrl as string) || null,
          bodyHtml: args.text ? textToBodyHtml(args.text as string) : "",
        },
      });
      const base = process.env.NEXT_PUBLIC_APP_URL ?? "";
      const videoNote = videoError
        ? " ⚠️ The video URL wasn't recognized — YouTube/Vimeo links only; add it in the classroom editor."
        : "";
      return {
        resultText: `Added lesson “${lesson.title}” to “${tree.course.title}”${sectionNote}${
          args.published ? "" : " as an unpublished draft"
        }.${videoNote} ${base}/c/${ctx.subAccountId}/${group.slug}/classroom/${tree.course.id}/${lesson.id}`,
        ref: { kind: "lesson", id: lesson.id },
      };
    },
  },
  {
    name: "watchdog_status",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    menuLabel: "Check the Inbox follow-up monitor — settings and what it flagged recently",
    description:
      "Show the Inbox follow-up monitor's settings (on/off, waiting threshold, quiet hours, extra criteria) and its recent runs — how many conversations it scanned, which contacts it flagged and why. Lives under AI Agents → Monitors. Use for 'is the inbox monitor on?', 'what did the watchdog flag this week?'. Requires the Agent monitors gate for this workspace.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "Check the Inbox follow-up monitor.",
    execute: async (ctx) => {
      const subSnap = await getAdminDb().doc(`subAccounts/${ctx.subAccountId!}`).get();
      if (subSnap.data()?.agentsEnabledByAgency !== true) {
        throw new CapabilityUserError(
          "Agent monitors aren't enabled for this workspace, so the Inbox follow-up monitor isn't available. The agency owner can turn on the Agent monitors gate from the sub-account's Manage dialog."
        );
      }
      const [config, runs] = await Promise.all([
        getWatchdogConfig(ctx.subAccountId!),
        listWatchdogRuns(ctx.subAccountId!, 7),
      ]);
      const quiet = config.quietHours
        ? `${config.quietHours.startHour}:00–${config.quietHours.endHour}:00 ${config.quietHours.timezone}`
        : "none";
      const head = `Inbox follow-up monitor: ${config.enabled ? "ON" : "OFF"} — flags customer messages unanswered for ${config.thresholdHours}h; quiet hours for pushes: ${quiet}${
        config.instructions ? `; extra criteria: “${config.instructions}”` : ""
      }; AI tokens used: ${config.totalTokensUsed.toLocaleString("en-US")} (daily budget ${config.dailyTokenBudget.toLocaleString("en-US")}).`;
      if (runs.length === 0) {
        return { resultText: `${head}\nNo runs yet${config.enabled ? " — it runs hourly." : "."}` };
      }
      const runLines = runs.map((r) => {
        const when = r.startedAt ? r.startedAt.slice(0, 16).replace("T", " ") : "?";
        if (r.status !== "completed") {
          return `- ${when}: ${r.status}${r.skippedReason ? ` (${r.skippedReason})` : ""}`;
        }
        const flagged = r.actions
          .slice(0, 5)
          .map((a) => `${a.contactName}${a.urgency === "high" ? " [high]" : ""}: ${a.reason}`)
          .join("; ");
        return `- ${when}: scanned ${r.scanned}, judged ${r.judged}, flagged ${r.flagged}${
          flagged ? ` → ${flagged}` : ""
        }`;
      });
      return {
        resultText: `${head}\nRecent runs (UTC):\n${runLines.join("\n")}\nEach flagged thread got a Task + a push to the team.`,
      };
    },
  },
  {
    name: "configure_watchdog",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    menuLabel: "Turn the Inbox follow-up monitor on/off or change its threshold and quiet hours",
    description:
      "Change the Inbox follow-up monitor (AI Agents → Monitors): enable/disable it, set the waiting threshold (1–24 hours before an unanswered customer message is judged), give it extra judging criteria, or set/clear quiet hours for push notifications (workspace timezone). Only send the fields being changed. Check watchdog_status first. Enabling needs the Agent monitors gate on for this workspace (it spends AI credits).",
    parameters: {
      type: "object",
      properties: {
        enabled: { type: "boolean", description: "Turn the watchdog on or off." },
        thresholdHours: {
          type: "integer",
          minimum: 1,
          maximum: 24,
          description: "Hours a customer message may sit unanswered before it's judged.",
        },
        instructions: {
          type: "string",
          description: "Extra criteria for the judge (≤1000 chars). Empty string clears.",
        },
        quietStartHour: { type: "integer", minimum: 0, maximum: 23, description: "Quiet hours start (0–23)." },
        quietEndHour: { type: "integer", minimum: 0, maximum: 23, description: "Quiet hours end (0–23)." },
        clearQuietHours: { type: "boolean", description: "true to remove quiet hours." },
      },
      additionalProperties: false,
    },
    validate: (raw) => {
      const enabled = bool(raw, "enabled");
      const thresholdHours = num(raw, "thresholdHours");
      if (
        thresholdHours !== null &&
        (!Number.isInteger(thresholdHours) || thresholdHours < 1 || thresholdHours > 24)
      ) {
        return { ok: false, error: "thresholdHours must be a whole number from 1 to 24" };
      }
      const r = raw as Record<string, unknown>;
      const hasInstructions = typeof r?.instructions === "string";
      const instructions = hasInstructions ? str(raw, "instructions").slice(0, 1000) : null;
      const qs = num(raw, "quietStartHour");
      const qe = num(raw, "quietEndHour");
      const clearQuiet = bool(raw, "clearQuietHours") === true;
      if ((qs === null) !== (qe === null)) {
        return { ok: false, error: "give both quietStartHour and quietEndHour (or neither)" };
      }
      if (
        qs !== null &&
        (!Number.isInteger(qs) || !Number.isInteger(qe) || qs < 0 || qs > 23 || qe! < 0 || qe! > 23)
      ) {
        return { ok: false, error: "quiet hours must be whole hours from 0 to 23" };
      }
      if (enabled === null && thresholdHours === null && !hasInstructions && qs === null && !clearQuiet) {
        return { ok: false, error: "nothing to change — give at least one setting" };
      }
      return {
        ok: true,
        args: {
          enabled,
          thresholdHours,
          hasInstructions,
          instructions,
          quietStartHour: qs,
          quietEndHour: qe,
          clearQuietHours: clearQuiet,
        },
      };
    },
    summarize: (args) => {
      const parts: string[] = [];
      if (args.enabled === true) parts.push("turn it ON");
      if (args.enabled === false) parts.push("turn it OFF");
      if (args.thresholdHours !== null) parts.push(`threshold ${args.thresholdHours}h`);
      if (args.hasInstructions) {
        parts.push(args.instructions ? `criteria “${args.instructions}”` : "clear the extra criteria");
      }
      if (args.quietStartHour !== null) parts.push(`quiet hours ${args.quietStartHour}:00–${args.quietEndHour}:00`);
      if (args.clearQuietHours) parts.push("clear quiet hours");
      return `Inbox follow-up monitor: ${parts.join(", ")}.`;
    },
    execute: async (ctx, args) => {
      const subSnap = await getAdminDb().doc(`subAccounts/${ctx.subAccountId!}`).get();
      const sub = subSnap.data() ?? {};
      if (sub.agentsEnabledByAgency !== true) {
        throw new CapabilityUserError(
          "Agent monitors aren't enabled for this workspace, so the Inbox follow-up monitor can't be configured. The agency owner can turn on the Agent monitors gate from the sub-account's Manage dialog."
        );
      }
      const patch: Parameters<typeof upsertWatchdogConfig>[2] = {};
      if (args.enabled !== null) patch.enabled = args.enabled as boolean;
      if (args.thresholdHours !== null) patch.thresholdHours = args.thresholdHours as number;
      if (args.hasInstructions) patch.instructions = (args.instructions as string) || null;
      if (args.clearQuietHours) {
        patch.quietHours = null;
      } else if (args.quietStartHour !== null) {
        const tz = await subAccountTimezone(ctx.subAccountId!);
        const quiet: WatchdogQuietHours = {
          startHour: args.quietStartHour as number,
          endHour: args.quietEndHour as number,
          timezone: tz,
        };
        patch.quietHours = quiet;
      }
      const cfg = await upsertWatchdogConfig(ctx.subAccountId!, ctx.agencyId, patch);
      return {
        resultText: `Inbox monitor updated: ${cfg.enabled ? "ON" : "OFF"}, threshold ${cfg.thresholdHours}h, quiet hours ${
          cfg.quietHours
            ? `${cfg.quietHours.startHour}:00–${cfg.quietHours.endHour}:00 ${cfg.quietHours.timezone}`
            : "none"
        }${cfg.instructions ? `, criteria set` : ""}. ${
          cfg.enabled ? "It runs hourly and only ever adds Tasks + pushes — it never messages customers." : ""
        }`,
        ref: { kind: "customAgent", id: ctx.subAccountId! },
      };
    },
  },
  {
    name: "stale_deals_status",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    menuLabel: "Check the Stale deals monitor — settings and which deals it flagged",
    description:
      "Show the Stale deals monitor's settings (on/off, days-in-stage threshold, watched pipelines, ignored stages, quiet hours, guidance) and its recent runs — how many deals sat past the threshold and which ones got a follow-up task with a suggested next step. Lives under AI Agents → Monitors. Use for 'is the stale deals monitor on?', 'which deals got flagged as stalled?'. Requires the Agent monitors gate for this workspace.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "Check the Stale deals monitor.",
    execute: async (ctx) => {
      const subSnap = await getAdminDb().doc(`subAccounts/${ctx.subAccountId!}`).get();
      if (subSnap.data()?.agentsEnabledByAgency !== true) {
        throw new CapabilityUserError(
          "Agent monitors aren't enabled for this workspace, so the Stale deals monitor isn't available. The agency owner can turn on the Agent monitors gate from the sub-account's Manage dialog."
        );
      }
      const [config, runs] = await Promise.all([
        getStaleDealsConfig(ctx.subAccountId!),
        listAgentRuns(ctx.subAccountId!, "stale-deals", 7),
      ]);
      const quiet = config.quietHours
        ? `${config.quietHours.startHour}:00–${config.quietHours.endHour}:00 ${config.quietHours.timezone}`
        : "none";
      const scope = config.pipelineIds ? `pipelines ${config.pipelineIds.join(", ")}` : "every pipeline";
      const ignored = config.excludeStageKeys.length
        ? `; ignoring stages ${config.excludeStageKeys.join(", ")}`
        : "";
      const head = `Stale deals monitor: ${config.enabled ? "ON" : "OFF"} — flags deals sitting ${config.thresholdDays}+ days in one stage with no open task, message or activity, across ${scope}${ignored}; quiet hours for pushes: ${quiet}${
        config.instructions ? `; guidance: “${config.instructions}”` : ""
      }; AI tokens used: ${config.totalTokensUsed.toLocaleString("en-US")} (daily budget ${config.dailyTokenBudget.toLocaleString("en-US")}).`;
      if (runs.length === 0) {
        return { resultText: `${head}\nNo runs yet${config.enabled ? " — it runs hourly." : "."}` };
      }
      const runLines = runs.map((r) => {
        const when = r.startedAt ? r.startedAt.slice(0, 16).replace("T", " ") : "?";
        if (r.status !== "completed") {
          return `- ${when}: ${r.status}${r.skippedReason ? ` (${r.skippedReason})` : ""}`;
        }
        const flagged = r.actions
          .slice(0, 5)
          .map((a) => `${a.dealTitle ?? a.contactName}: ${a.reason}`)
          .join("; ");
        return `- ${when}: ${r.scanned} past threshold, flagged ${r.flagged}${
          flagged ? ` → ${flagged}` : ""
        }`;
      });
      return {
        resultText: `${head}\nRecent runs (UTC):\n${runLines.join("\n")}\nEach flagged deal got a Task (linked to the deal) + a push to the team.`,
      };
    },
  },
  {
    name: "configure_stale_deals_monitor",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    menuLabel: "Turn the Stale deals monitor on/off or change its threshold and quiet hours",
    description:
      "Change the Stale deals monitor (AI Agents → Monitors): enable/disable it, set the days-in-stage threshold (3–60 days before a deal with no open task, message or activity is flagged), give guidance for the suggested next step, or set/clear quiet hours for push notifications (workspace timezone). Pipeline and stage filters are set on the Monitors tab, not here. Only send the fields being changed. Check stale_deals_status first. Enabling needs the Agent monitors gate on for this workspace (it spends AI credits).",
    parameters: {
      type: "object",
      properties: {
        enabled: { type: "boolean", description: "Turn the monitor on or off." },
        thresholdDays: {
          type: "integer",
          minimum: 3,
          maximum: 60,
          description: "Days a deal may sit in one stage before it's flagged.",
        },
        instructions: {
          type: "string",
          description: "Guidance for the suggested next step (≤1000 chars). Empty string clears.",
        },
        quietStartHour: { type: "integer", minimum: 0, maximum: 23, description: "Quiet hours start (0–23)." },
        quietEndHour: { type: "integer", minimum: 0, maximum: 23, description: "Quiet hours end (0–23)." },
        clearQuietHours: { type: "boolean", description: "true to remove quiet hours." },
      },
      additionalProperties: false,
    },
    validate: (raw) => {
      const enabled = bool(raw, "enabled");
      const thresholdDays = num(raw, "thresholdDays");
      if (
        thresholdDays !== null &&
        (!Number.isInteger(thresholdDays) || thresholdDays < 3 || thresholdDays > 60)
      ) {
        return { ok: false, error: "thresholdDays must be a whole number from 3 to 60" };
      }
      const r = raw as Record<string, unknown>;
      const hasInstructions = typeof r?.instructions === "string";
      const instructions = hasInstructions ? str(raw, "instructions").slice(0, 1000) : null;
      const qs = num(raw, "quietStartHour");
      const qe = num(raw, "quietEndHour");
      const clearQuiet = bool(raw, "clearQuietHours") === true;
      if ((qs === null) !== (qe === null)) {
        return { ok: false, error: "give both quietStartHour and quietEndHour (or neither)" };
      }
      if (
        qs !== null &&
        (!Number.isInteger(qs) || !Number.isInteger(qe) || qs < 0 || qs > 23 || qe! < 0 || qe! > 23)
      ) {
        return { ok: false, error: "quiet hours must be whole hours from 0 to 23" };
      }
      if (enabled === null && thresholdDays === null && !hasInstructions && qs === null && !clearQuiet) {
        return { ok: false, error: "nothing to change — give at least one setting" };
      }
      return {
        ok: true,
        args: {
          enabled,
          thresholdDays,
          hasInstructions,
          instructions,
          quietStartHour: qs,
          quietEndHour: qe,
          clearQuietHours: clearQuiet,
        },
      };
    },
    summarize: (args) => {
      const parts: string[] = [];
      if (args.enabled === true) parts.push("turn it ON");
      if (args.enabled === false) parts.push("turn it OFF");
      if (args.thresholdDays !== null) parts.push(`threshold ${args.thresholdDays} days`);
      if (args.hasInstructions) {
        parts.push(args.instructions ? `guidance “${args.instructions}”` : "clear the guidance");
      }
      if (args.quietStartHour !== null) parts.push(`quiet hours ${args.quietStartHour}:00–${args.quietEndHour}:00`);
      if (args.clearQuietHours) parts.push("clear quiet hours");
      return `Stale deals monitor: ${parts.join(", ")}.`;
    },
    execute: async (ctx, args) => {
      const subSnap = await getAdminDb().doc(`subAccounts/${ctx.subAccountId!}`).get();
      const sub = subSnap.data() ?? {};
      if (sub.agentsEnabledByAgency !== true) {
        throw new CapabilityUserError(
          "Agent monitors aren't enabled for this workspace, so the Stale deals monitor can't be configured. The agency owner can turn on the Agent monitors gate from the sub-account's Manage dialog."
        );
      }
      const patch: Parameters<typeof upsertStaleDealsConfig>[2] = {};
      if (args.enabled !== null) patch.enabled = args.enabled as boolean;
      if (args.thresholdDays !== null) patch.thresholdDays = args.thresholdDays as number;
      if (args.hasInstructions) patch.instructions = (args.instructions as string) || null;
      if (args.clearQuietHours) {
        patch.quietHours = null;
      } else if (args.quietStartHour !== null) {
        const tz = await subAccountTimezone(ctx.subAccountId!);
        const quiet: WatchdogQuietHours = {
          startHour: args.quietStartHour as number,
          endHour: args.quietEndHour as number,
          timezone: tz,
        };
        patch.quietHours = quiet;
      }
      const cfg = await upsertStaleDealsConfig(ctx.subAccountId!, ctx.agencyId, patch);
      return {
        resultText: `Stale deals monitor updated: ${cfg.enabled ? "ON" : "OFF"}, threshold ${cfg.thresholdDays} days, quiet hours ${
          cfg.quietHours
            ? `${cfg.quietHours.startHour}:00–${cfg.quietHours.endHour}:00 ${cfg.quietHours.timezone}`
            : "none"
        }${cfg.instructions ? `, guidance set` : ""}. ${
          cfg.enabled ? "It runs hourly and only ever adds Tasks + pushes — it never messages customers or moves deals." : ""
        }`,
        ref: { kind: "customAgent", id: `${ctx.subAccountId!}_stale-deals` },
      };
    },
  },
  {
    name: "slack_status",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    menuLabel: "Check the Slack connection — channel, events posted, last post",
    description:
      "Show whether this workspace posts notifications to a Slack channel (Settings Sub-Account → Admin tab → Slack notifications): connected or not, the channel name the admin noted, which events are ticked, when the last post went out, and any error (e.g. a revoked webhook URL that needs reconnecting). Use for 'is Slack connected?', 'what do we post to Slack?'.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "Check the Slack connection.",
    execute: async (ctx) => {
      const cfg = await getSlackConfig(ctx.subAccountId!);
      if (!cfg.connected) {
        return {
          resultText:
            "Slack isn't connected for this workspace. An admin can connect it with connect_slack (the webhook URL is entered on the confirmation card) or under Settings Sub-Account → Admin tab → Slack notifications.",
        };
      }
      const last = cfg.lastSentAt ? cfg.lastSentAt.slice(0, 16).replace("T", " ") + " UTC" : "never";
      return {
        resultText: `Slack: connected${cfg.channelLabel ? ` to ${cfg.channelLabel}` : ""}${
          cfg.needsReconnect ? " — NEEDS RECONNECT (Slack rejected the webhook URL)" : ""
        }. Posting on: ${cfg.events.length ? cfg.events.join(", ") : "no events ticked"}. Last post: ${last}.${
          cfg.lastError ? ` Last error: ${cfg.lastError}` : ""
        }`,
      };
    },
  },
  {
    name: "configure_slack_events",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    menuLabel: "Change which events post to Slack",
    description:
      "Replace the list of events that post to the connected Slack channel. Give the full list of event types to keep on (e.g. contact.created, booking.created, message.received, call.missed, quote.accepted, quote.declined, deal.won, order.paid). Check slack_status first and include the ones already on that should stay. Only works once Slack is connected; to connect, use connect_slack.",
    parameters: {
      type: "object",
      properties: {
        events: {
          type: "array",
          items: { type: "string" },
          description: "Full list of webhook event types to post. Unknown names are ignored.",
        },
      },
      required: ["events"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const r = raw as Record<string, unknown>;
      const events = sanitizeSlackEvents(r?.events);
      if (!Array.isArray(r?.events)) {
        return { ok: false, error: "events must be a list of event types" };
      }
      return { ok: true, args: { events } };
    },
    summarize: (args) =>
      `Post to Slack on: ${(args.events as string[]).length ? (args.events as string[]).join(", ") : "nothing"}.`,
    execute: async (ctx, args) => {
      try {
        const cfg = await updateSlackEvents(ctx.subAccountId!, args.events as WebhookEventType[]);
        invalidateSlackHookCache(ctx.subAccountId!);
        return {
          resultText: `Slack events updated: ${cfg.events.length ? cfg.events.join(", ") : "none"}.`,
        };
      } catch (err) {
        if (err instanceof SlackError) throw new CapabilityUserError(err.message);
        throw err;
      }
    },
  },
  {
    name: "connect_slack",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    menuLabel: "Connect a Slack channel for notifications (you paste the webhook URL on the confirmation card)",
    description:
      "Connect this workspace to a Slack channel so ticked events post there, or reconnect with a new URL after Slack revoked the old one. The Slack Incoming Webhook URL is NOT an argument: the confirmation card shows a field where the user pastes it, and it goes straight to the server. Never ask the user to paste the URL into the chat; if they do, tell them to use the field on the card instead. Before proposing, tell them how to get one if they don't have it: in Slack, api.slack.com/apps → Create New App → From scratch → Incoming Webhooks → Activate → Add New Webhook to Workspace → pick the channel → copy the URL. Pass channelLabel (e.g. '#sales') when they name the channel, and events only when they ask for specific ones; otherwise the defaults are used (new lead, inbound message, new booking, missed call, quote accepted, quote declined). Connecting sends a test message to the channel.",
    parameters: {
      type: "object",
      properties: {
        channelLabel: {
          type: "string",
          description: "Channel name to show on the card, e.g. '#sales'. Optional.",
        },
        events: {
          type: "array",
          items: { type: "string" },
          description:
            "Event types to post. Omit for the defaults. Unknown names are ignored.",
        },
      },
      additionalProperties: false,
    },
    secretInputs: [
      {
        key: "webhookUrl",
        label: "Slack Incoming Webhook URL",
        placeholder: "https://hooks.slack.com/services/T…/B…/…",
        help: "From Slack: api.slack.com/apps → your app → Incoming Webhooks. Sent straight to the server; it never enters the chat.",
      },
    ],
    validate: (raw) => {
      const r = (raw ?? {}) as Record<string, unknown>;
      const channelLabel = str(raw, "channelLabel").slice(0, 60);
      if (r.events !== undefined && !Array.isArray(r.events)) {
        return { ok: false, error: "events must be a list of event types" };
      }
      const events =
        r.events === undefined ? undefined : sanitizeSlackEvents(r.events);
      // Friendly names ("new lead") sanitise to nothing; silently connecting
      // with no events would look like success and never post.
      if (events && events.length === 0 && (r.events as unknown[]).length > 0) {
        return {
          ok: false,
          error: `none of those event names are recognised; use event types such as ${DEFAULT_SLACK_EVENTS.join(", ")}, or omit events for the defaults`,
        };
      }
      // The URL arrives only from the confirm card; the proposal has none.
      // Its shape is checked once, inside connectSlack.
      const webhookUrl = str(raw, "webhookUrl");
      return {
        ok: true,
        args: {
          ...(channelLabel ? { channelLabel } : {}),
          ...(events ? { events } : {}),
          ...(webhookUrl ? { webhookUrl } : {}),
        },
      };
    },
    summarize: (args) => {
      const events = args.events as string[] | undefined;
      // Omitted events keep the current picks on a reconnect (connectSlack
      // falls back to the defaults only on a first connect).
      const posting = events
        ? events.length
          ? events.join(", ")
          : "nothing yet (events can be turned on later)"
        : `the current picks, or on a first connect the defaults (${DEFAULT_SLACK_EVENTS.join(", ")})`;
      return `Connect Slack${args.channelLabel ? ` (${args.channelLabel})` : ""}, send a test message, and post on: ${posting}.`;
    },
    execute: async (ctx, args) => {
      const webhookUrl = typeof args.webhookUrl === "string" ? args.webhookUrl : "";
      if (!webhookUrl) {
        throw new CapabilityUserError(
          "Paste the Slack Incoming Webhook URL into the field on the confirmation card first.",
        );
      }
      try {
        const cfg = await connectSlack({
          subAccountId: ctx.subAccountId!,
          uid: ctx.uid,
          webhookUrl,
          ...(typeof args.channelLabel === "string"
            ? { channelLabel: args.channelLabel }
            : {}),
          ...(Array.isArray(args.events)
            ? { events: args.events as WebhookEventType[] }
            : {}),
        });
        invalidateSlackHookCache(ctx.subAccountId!);
        return {
          resultText: `Slack connected${cfg.channelLabel ? ` to ${cfg.channelLabel}` : ""}; a test message was posted. Posting on: ${cfg.events.length ? cfg.events.join(", ") : "nothing yet"}.`,
        };
      } catch (err) {
        if (err instanceof SlackError) throw new CapabilityUserError(err.message);
        throw err;
      }
    },
  },

  // Agency level, continued
  {
    name: "list_snapshots",
    level: "agency",
    requiredRole: "agencyOwner",
    readonly: true,
    menuLabel: "See the agency's saved Snapshots (reusable sub-account setups)",
    description:
      "List this agency's Snapshots — saved bundles of forms, message templates, products, and workflows captured from a proven sub-account — with their ids and what each contains. Use it to resolve a snapshot's id before create_sub_account with snapshotId — never guess ids.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "List snapshots.",
    execute: async (ctx) => {
      const snap = await getAdminDb()
        .collection(`agencies/${ctx.agencyId}/snapshots`)
        .limit(50)
        .get();
      if (snap.empty) {
        return {
          resultText:
            "No snapshots yet. Capture one from a well-set-up sub-account under Agency → Sub-accounts → Snapshots.",
        };
      }
      const lines = snap.docs.map((d) => {
        const data = d.data();
        const p = (data.payload ?? {}) as Partial<SnapshotPayload>;
        const counts = [
          `${p.forms?.length ?? 0} forms`,
          `${p.messageTemplates?.length ?? 0} templates`,
          `${p.products?.length ?? 0} products`,
          `${p.workflows?.length ?? 0} workflows`,
        ].join(", ");
        return `- ${(data.name as string) || "(unnamed)"}${
          data.description ? ` — ${data.description}` : ""
        } (${counts}) — id: ${d.id}`;
      });
      return { resultText: `Snapshots (${snap.size}):\n${lines.join("\n")}` };
    },
  },
  {
    name: "billing_overview",
    level: "agency",
    requiredRole: "agencyOwner",
    readonly: true,
    menuLabel: "See every client's billing state — who's paying, pending, in grace, or lapsed",
    description:
      "List this agency's sub-accounts with their Client-billing state: comped (not billed), pending (plan assigned, checkout not completed), active, grace (renewal failed, inside the 7-day grace window), or lapsed (paywalled), plus whether usage rebilling is on for the client and any overdue monthly usage charge. filter 'needs-attention' = pending + grace + lapsed + usage overdue. Use for 'who hasn't paid?', 'which clients are past due?', 'what's my MRR?'.",
    parameters: {
      type: "object",
      properties: {
        filter: {
          type: "string",
          enum: ["all", "needs-attention", "active", "comped"],
          description: "Default 'all'.",
        },
      },
      additionalProperties: false,
    },
    validate: (raw) => {
      const filter = str(raw, "filter") || "all";
      if (!["all", "needs-attention", "active", "comped"].includes(filter)) {
        return { ok: false, error: "filter must be all, needs-attention, active, or comped" };
      }
      return { ok: true, args: { filter } };
    },
    summarize: (args) => `Show billing overview (${args.filter}).`,
    execute: async (ctx, args) => {
      const snap = await getAdminDb()
        .collection("subAccounts")
        .where("agencyId", "==", ctx.agencyId)
        .get();
      const rows = snap.docs.map((d) => {
        const data = d.data();
        const billing = (data.billing ?? null) as SubAccountBilling | null;
        const state = effectiveBillingState(billing);
        const cents = billing?.priceCents ?? null;
        const interval = billing?.billingInterval === "year" ? "yr" : "mo";
        const currency = billing?.currency ?? "usd";
        const graceUntil = toDate(billing?.graceUntil);
        return {
          id: d.id,
          name: (data.name as string) || "(unnamed)",
          number: typeof data.accountNumber === "number" ? `#${data.accountNumber}` : "",
          state,
          plan: billing?.planName ?? null,
          price: cents !== null ? `${fmtCents(cents, currency)}/${interval}` : null,
          monthlyCents:
            state === "active" && cents !== null
              ? billing?.billingInterval === "year"
                ? cents / 12
                : cents
              : 0,
          currency,
          graceUntil,
          rebilled: data.usageRebillingEnabled === true,
          usageOverdue: (data.usageOverdue ?? null) as {
            amountCents?: number;
            currency?: string;
            usageMonth?: string | null;
          } | null,
        };
      });
      const wanted = rows.filter((r) =>
        args.filter === "all"
          ? true
          : args.filter === "needs-attention"
            ? ["pending", "grace", "lapsed"].includes(r.state) || !!r.usageOverdue
            : r.state === args.filter
      );
      const mrr = rows
        .filter((r) => r.monthlyCents > 0)
        .reduce<Record<string, number>>((acc, r) => {
          acc[r.currency] = (acc[r.currency] ?? 0) + r.monthlyCents;
          return acc;
        }, {});
      const mrrLine = Object.keys(mrr).length
        ? `MRR (active, annual ÷ 12): ${Object.entries(mrr)
            .map(([c, v]) => fmtCents(Math.round(v), c))
            .join(", ")}.`
        : "MRR: none yet (no active subscriptions).";
      if (wanted.length === 0) {
        return {
          resultText: `No sub-accounts match “${args.filter}”. ${mrrLine}`,
        };
      }
      const order: Record<string, number> = { lapsed: 0, grace: 1, pending: 2, active: 3, comped: 4 };
      wanted.sort((a, b) => (order[a.state] ?? 9) - (order[b.state] ?? 9));
      const lines = wanted.slice(0, 40).map(
        (r) =>
          `- ${r.name} ${r.number} — ${r.state.toUpperCase()}${r.plan ? `, ${r.plan}` : ""}${
            r.price ? ` ${r.price}` : ""
          }${r.state === "grace" && r.graceUntil ? `, grace ends ${r.graceUntil.toISOString().slice(0, 10)}` : ""}${
            r.usageOverdue
              ? `, USAGE OVERDUE ${fmtCents(r.usageOverdue.amountCents ?? 0, r.usageOverdue.currency ?? "usd")}${r.usageOverdue.usageMonth ? ` (${r.usageOverdue.usageMonth})` : ""}`
              : ""
          }${r.rebilled ? ", usage rebilled" : ""} — id: ${r.id}`
      );
      const counts = (["active", "pending", "grace", "lapsed", "comped"] as const)
        .map((s) => `${rows.filter((r) => r.state === s).length} ${s}`)
        .join(", ");
      return {
        resultText: `Client billing (${counts}):\n${lines.join("\n")}${
          wanted.length > 40 ? `\n(+${wanted.length - 40} more — see Agency → Client billing)` : ""
        }\n${mrrLine}`,
      };
    },
  },
  {
    name: "deployment_setup_status",
    level: "agency",
    requiredRole: "agencyOwner",
    readonly: true,
    menuLabel:
      "Check my deployment's setup — which integrations are configured and which still need keys",
    description:
      "Report the deployment-wide configuration state: which required settings are in place, which optional integrations (email, SMS, automations, AI agents, voice, maps, calendar sync, push, chat…) are configured, partially configured, or still off, and which key NAMES are missing. Reads presence only — never values. Use for 'what's the status of my setup?', 'is email/SMS/AI configured?', 'what keys am I missing?', 'what should I set up next?'. Per-client settings (a sub-account's Stripe, Twilio number, sending domain, feature gates) are NOT here — use list_sub_accounts / billing tools for those.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "Check deployment setup status.",
    execute: async () => {
      // This build's own process.env (same check as the Get-started banner and
      // Guided setup). Key names only; values never leave the server.
      const getValue = (k: string) => process.env[k];
      const relevant = SETUP_GROUPS.filter((g) => g.tier !== "preflight").filter(
        (g) => !g.variant || g.variant === LANDING_VARIANT,
      );
      const required: string[] = [];
      const configured: string[] = [];
      const partial: string[] = [];
      const off: string[] = [];
      for (const g of relevant) {
        const res = evaluateSetupGroup(g, getValue);
        if (g.tier === "boot") {
          required.push(
            res.status === "error"
              ? `✗ ${g.title} — missing: ${res.missingReq.join(", ")}`
              : `✓ ${g.title}`,
          );
          continue;
        }
        if (res.status === "ok") {
          configured.push(`✓ ${g.title}`);
        } else if (res.status === "off") {
          off.push(
            `○ ${g.title}${g.off ? ` — while off: ${g.off}` : ""}${
              res.missingReq.length ? ` (needs: ${res.missingReq.join(", ")})` : ""
            }`,
          );
        } else {
          const notes = res.notes.map((n) => n.msg).slice(0, 2).join("; ");
          partial.push(
            `⚠ ${g.title}${
              res.missingReq.length ? ` — missing: ${res.missingReq.join(", ")}` : ""
            }${notes ? ` — ${notes}` : ""}`,
          );
        }
      }
      const sections = [
        `Required to run:\n${required.join("\n")}`,
        configured.length
          ? `Configured integrations (${configured.length}):\n${configured.join("\n")}`
          : "Configured integrations: none yet.",
        partial.length ? `Needs attention (${partial.length}):\n${partial.join("\n")}` : "",
        off.length ? `Not set up yet (${off.length}):\n${off.join("\n")}` : "",
        "Add or update keys under Agency → Settings Agency → Guided setup (/agency/setup) — new values take effect after the redeploy the form triggers. Per-client credentials (each sub-account's Stripe, Twilio number, sending domain, Facebook/Instagram) live in that sub-account's Settings.",
      ].filter(Boolean);
      return { resultText: sections.join("\n\n") };
    },
  },
  {
    name: "comp_client",
    level: "agency",
    requiredRole: "agencyOwner",
    menuLabel: "Comp a client — stop billing them (cancels their subscription)",
    description:
      "Mark a sub-account as comped: it's no longer billed, any live Stripe subscription is CANCELLED, and the workspace is never paywalled. Feature gates stay as they are (change them with set_feature_gate). Resolve the sub-account's id with list_sub_accounts first — never guess ids. Confirm the user really wants to stop charging this client.",
    parameters: {
      type: "object",
      properties: {
        subAccountId: { type: "string", description: "Sub-account id from list_sub_accounts." },
        subAccountName: { type: "string", description: "Its name, for the confirmation card." },
      },
      required: ["subAccountId", "subAccountName"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const subAccountId = str(raw, "subAccountId");
      if (!subAccountId) {
        return { ok: false, error: "the sub-account id is required — look it up with list_sub_accounts" };
      }
      return { ok: true, args: { subAccountId, subAccountName: str(raw, "subAccountName") } };
    },
    summarize: (args) =>
      `Comp “${args.subAccountName || args.subAccountId}” — stop billing them and cancel any active subscription.`,
    execute: async (ctx, args) => {
      try {
        await compSubAccount({
          agencyId: ctx.agencyId,
          subAccountId: args.subAccountId as string,
        });
      } catch (err) {
        if (err instanceof BillingError) throw new CapabilityUserError(err.message);
        throw err;
      }
      return {
        resultText: `“${args.subAccountName || args.subAccountId}” is now comped — no further charges, any subscription cancelled, and the workspace won't be paywalled. Their feature gates are unchanged.`,
        ref: { kind: "subAccount", id: args.subAccountId as string },
      };
    },
  },
  {
    name: "resend_checkout_link",
    level: "agency",
    requiredRole: "agencyOwner",
    menuLabel: "Get a fresh checkout link for a client who hasn't paid yet",
    description:
      "Mint a new secure checkout link for a sub-account whose plan is assigned but not yet paid (state 'pending'), so the user can send it to the client. Re-minting invalidates older links. Resolve the sub-account's id with list_sub_accounts (or billing_overview) first — never guess ids. Not for active subscriptions (use the billing portal) or comped clients (assign a plan first).",
    parameters: {
      type: "object",
      properties: {
        subAccountId: { type: "string", description: "Sub-account id from list_sub_accounts." },
        subAccountName: { type: "string", description: "Its name, for the confirmation card." },
      },
      required: ["subAccountId", "subAccountName"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const subAccountId = str(raw, "subAccountId");
      if (!subAccountId) {
        return { ok: false, error: "the sub-account id is required — look it up with list_sub_accounts" };
      }
      return { ok: true, args: { subAccountId, subAccountName: str(raw, "subAccountName") } };
    },
    summarize: (args) =>
      `Mint a fresh checkout link for “${args.subAccountName || args.subAccountId}” (older links stop working).`,
    execute: async (ctx, args) => {
      let url: string;
      try {
        url = await mintCheckoutLink({
          agencyId: ctx.agencyId,
          subAccountId: args.subAccountId as string,
        });
      } catch (err) {
        if (err instanceof BillingError) throw new CapabilityUserError(err.message);
        throw err;
      }
      return {
        resultText: `New checkout link for “${args.subAccountName || args.subAccountId}”: ${url}\nSend it to the client — their plan activates automatically when they pay. Any earlier link is now invalid. (To email it from the app, use the sub-account's Manage → Billing section.)`,
        ref: { kind: "subAccount", id: args.subAccountId as string },
      };
    },
  },
  {
    name: "sub_account_usage",
    level: "agency",
    requiredRole: "agencyOwner",
    readonly: true,
    menuLabel: "See a sub-account's usage this month against its limits",
    description:
      "Show one sub-account's current-month usage — emails, SMS segments (and how many went through the shared number, the only billable part), WhatsApp messages, AI replies, AI tokens, phone and web voice minutes — against its effective limits (workspace override → plan → unlimited), whether usage rebilling is on, the running usage-charge estimate (overage + flat fees) and the agency's actual AI cost for this client. Resolve the sub-account's id with list_sub_accounts first — never guess ids. Use for 'how much SMS has Acme used?', 'is anyone near their limit?', 'what will Acme's usage charge be?'.",
    parameters: {
      type: "object",
      properties: {
        subAccountId: { type: "string", description: "Sub-account id from list_sub_accounts." },
        subAccountName: { type: "string", description: "Its name, for the reply." },
      },
      required: ["subAccountId"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const subAccountId = str(raw, "subAccountId");
      if (!subAccountId) {
        return { ok: false, error: "the sub-account id is required — look it up with list_sub_accounts" };
      }
      return { ok: true, args: { subAccountId, subAccountName: str(raw, "subAccountName") } };
    },
    summarize: (args) => `Show usage for “${args.subAccountName || args.subAccountId}”.`,
    execute: async (ctx, args) => {
      const db = getAdminDb();
      const subSnap = await db.doc(`subAccounts/${args.subAccountId as string}`).get();
      if (!subSnap.exists || subSnap.data()?.agencyId !== ctx.agencyId) {
        throw new CapabilityUserError("That sub-account wasn't found in this agency.");
      }
      const sub = subSnap.data()!;
      const month = usageMonthKey();
      const usageSnap = await db.doc(`subAccounts/${subSnap.id}/usage/${month}`).get();
      const usage = (usageSnap.data() ?? {}) as UsageMonthDoc;
      const quotaSubject = {
        ...sub,
        agencyId: ctx.agencyId,
      } as Parameters<typeof getEffectiveBilling>[1];
      const billing = await getEffectiveBilling(subSnap.id, quotaSubject);
      const { quotas, rates } = billing;
      // Rates only accrue for a client being rebilled.
      const overage = billing.rebilling
        ? computeOverage(usage, quotas, rates)
        : { perUnit: {}, totalCents: 0 };
      const fmtLimit = (v: number | null | undefined) =>
        typeof v === "number" ? v.toLocaleString("en-US") : "unlimited";
      const pct = (used: number, limit: number | null | undefined) =>
        typeof limit === "number" && limit > 0
          ? ` (${Math.round((used / limit) * 100)}%${
              used >= limit
                ? billing.rebilling && rates
                  ? " — past the included amount (billed if the unit has a rate, else capped)"
                  : " — CAPPED"
                : ""
            })`
          : "";
      const voiceMin = Math.round((usage.voiceSeconds ?? 0) / 60);
      const webVoiceMin = Math.round((usage.webVoiceSeconds ?? 0) / 60);
      const lines = [
        `- Emails: ${(usage.emailsSent ?? 0).toLocaleString("en-US")} / ${fmtLimit(quotas?.emailsPerMonth)}${pct(usage.emailsSent ?? 0, quotas?.emailsPerMonth)}`,
        `- SMS segments: ${(usage.smsSegments ?? 0).toLocaleString("en-US")} / ${fmtLimit(quotas?.smsSegmentsPerMonth)}${pct(usage.smsSegments ?? 0, quotas?.smsSegmentsPerMonth)}`,
        `- WhatsApp messages: ${(usage.whatsappMessages ?? 0).toLocaleString("en-US")} / ${fmtLimit(quotas?.whatsappPerMonth)}${pct(usage.whatsappMessages ?? 0, quotas?.whatsappPerMonth)}`,
        `- AI tokens: ${(usage.aiTokens ?? 0).toLocaleString("en-US")} / ${fmtLimit(quotas?.aiTokensPerMonth)}${pct(usage.aiTokens ?? 0, quotas?.aiTokensPerMonth)}`,
        `- Voice minutes: ${voiceMin.toLocaleString("en-US")} / ${fmtLimit(quotas?.voiceMinutesPerMonth)}${pct(voiceMin, quotas?.voiceMinutesPerMonth)}`,
        `- AI replies: ${(usage.aiReplies ?? 0).toLocaleString("en-US")} / ${fmtLimit(quotas?.aiRepliesPerMonth)}${pct(usage.aiReplies ?? 0, quotas?.aiRepliesPerMonth)}`,
        `- Web voice minutes: ${webVoiceMin.toLocaleString("en-US")} / ${fmtLimit(quotas?.webVoiceMinutesPerMonth)}${pct(webVoiceMin, quotas?.webVoiceMinutesPerMonth)}`,
        `- SMS via the shared number (billable): ${(usage.smsSegmentsShared ?? 0).toLocaleString("en-US")}`,
      ];
      const source = sub.usageQuotas
        ? "workspace override"
        : sub.billing?.planId && quotas
          ? `plan “${sub.billing?.planName ?? sub.billing.planId}”`
          : "none set (unlimited)";
      const currency = (sub.billing?.currency as string | null) ?? "usd";
      const fees = billing.rebilling
        ? computeFeatureFees(usage, billing.featureFees)
        : { lines: [], totalCents: 0 };
      const costLine = `Your actual AI cost for this client this month: ${fmtCents(Math.round((usage.aiCostMicros ?? 0) / 10_000), "usd")} (not shown to the client).`;
      const overLine = billing.rebilling
        ? `Usage rebilling is ON. Estimated usage charge so far: ${fmtCents(overage.totalCents + fees.totalCents, currency)} (overage ${fmtCents(overage.totalCents, currency)}${
            fees.lines.length ? `, fees: ${fees.lines.map((l) => `${l.label} ${fmtCents(l.cents, currency)}`).join(", ")}` : ""
          }, excluding any amount carried from last month). It's invoiced on the 1st for the month before and paid by link.`
        : "Usage rebilling is OFF for this client, so nothing is billed (limits are hard caps).";
      return {
        resultText: `Usage for “${(sub.name as string) || subSnap.id}” — ${month} (limits from: ${source}):\n${lines.join("\n")}\n${overLine} ${costLine} Capped channels pause until the month resets or the limit is raised (set_usage_limits).`,
      };
    },
  },
  {
    name: "set_usage_limits",
    level: "agency",
    requiredRole: "agencyOwner",
    menuLabel: "Set (or clear) a sub-account's monthly usage limits",
    description:
      "Set per-workspace monthly usage limits that OVERRIDE the plan's included allowances for one sub-account: emails, SMS segments, WhatsApp messages, AI tokens, AI replies, phone voice minutes, web voice minutes. Only the units given change; the others keep their current limit (from an existing override or the plan), copied into this client's own override, so later plan changes to included amounts stop applying to this client until clear=true. 0 is allowed: with a sell rate on a rebilled client it means billed from the first unit, otherwise it means unlimited. Pass clear=true to remove the override entirely (the plan's limits, if any, apply again). Resolve the sub-account's id with list_sub_accounts first — never guess ids. Limits take effect within a few minutes; when hit, that channel pauses for the workspace until the month resets — except a unit with a sell rate on a client whose usage is rebilled, where the limit is the included amount and further use is billed instead. Rates, flat fees, the spend ceiling and the rebilling switch are set in the Manage dialog's Billing & usage tab, not here.",
    parameters: {
      type: "object",
      properties: {
        subAccountId: { type: "string", description: "Sub-account id from list_sub_accounts." },
        subAccountName: { type: "string", description: "Its name, for the confirmation card." },
        emailsPerMonth: { type: "integer", minimum: 0 },
        smsSegmentsPerMonth: { type: "integer", minimum: 0 },
        whatsappPerMonth: { type: "integer", minimum: 0 },
        aiTokensPerMonth: { type: "integer", minimum: 0 },
        voiceMinutesPerMonth: { type: "integer", minimum: 0 },
        aiRepliesPerMonth: { type: "integer", minimum: 0 },
        webVoiceMinutesPerMonth: { type: "integer", minimum: 0 },
        clear: { type: "boolean", description: "true to remove the workspace override." },
      },
      required: ["subAccountId", "subAccountName"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const subAccountId = str(raw, "subAccountId");
      if (!subAccountId) {
        return { ok: false, error: "the sub-account id is required — look it up with list_sub_accounts" };
      }
      const clear = bool(raw, "clear") === true;
      const limits: UsageQuotas = {};
      for (const key of [
        "emailsPerMonth",
        "smsSegmentsPerMonth",
        "whatsappPerMonth",
        "aiTokensPerMonth",
        "voiceMinutesPerMonth",
        "aiRepliesPerMonth",
        "webVoiceMinutesPerMonth",
      ] as const) {
        const v = num(raw, key);
        if (v !== null) {
          if (!Number.isInteger(v) || v < 0) {
            return { ok: false, error: `${key} must be a whole number of 0 or more` };
          }
          limits[key] = v;
        }
      }
      if (!clear && Object.keys(limits).length === 0) {
        return { ok: false, error: "give at least one limit, or clear=true to remove the override" };
      }
      return {
        ok: true,
        args: { subAccountId, subAccountName: str(raw, "subAccountName"), clear, limits },
      };
    },
    summarize: (args) => {
      if (args.clear) {
        return `Remove the usage-limit override on “${args.subAccountName || args.subAccountId}” (plan limits apply again, or unlimited).`;
      }
      const l = args.limits as UsageQuotas;
      const show = (v: number | null | undefined, unit: string) =>
        typeof v === "number" ? `${v.toLocaleString("en-US")} ${unit}` : null;
      const parts = [
        show(l.emailsPerMonth, "emails"),
        show(l.smsSegmentsPerMonth, "SMS segments"),
        show(l.whatsappPerMonth, "WhatsApp messages"),
        show(l.aiTokensPerMonth, "AI tokens"),
        show(l.voiceMinutesPerMonth, "voice minutes"),
        show(l.aiRepliesPerMonth, "AI replies"),
        show(l.webVoiceMinutesPerMonth, "web voice minutes"),
      ].filter(Boolean);
      return `Set monthly limits on “${args.subAccountName || args.subAccountId}”: ${parts.join(", ")}. Other units keep their current limits, but they become this client's own copy: later changes to the plan's included amounts won't apply to this client until the override is cleared.`;
    },
    execute: async (ctx, args) => {
      const ref = getAdminDb().doc(`subAccounts/${args.subAccountId as string}`);
      const snap = await ref.get();
      if (!snap.exists || snap.data()?.agencyId !== ctx.agencyId) {
        throw new CapabilityUserError("That sub-account wasn't found in this agency.");
      }
      // Merge into what applies today, so changing one unit can't drop the
      // plan's other included amounts (which would bill a rebilled client from unit one).
      const current = args.clear
        ? null
        : (
            await getEffectiveBilling(snap.id, {
              ...(snap.data() as Record<string, unknown>),
              agencyId: ctx.agencyId,
            } as Parameters<typeof getEffectiveBilling>[1])
          ).quotas;
      const quotas = args.clear
        ? null
        : sanitizeUsageQuotas({ ...(current ?? {}), ...(args.limits as UsageQuotas) });
      await ref.update({
        usageQuotas: quotas,
        updatedAt: FieldValue.serverTimestamp(),
      });
      invalidateUsageBillingCache();
      const name = (snap.data()?.name as string) || snap.id;
      return {
        resultText: quotas
          ? `Limits saved for “${name}”. They apply within a few minutes; you're emailed and notified at 80% and 100% of any limit. A capped channel pauses until the month resets, except a unit with a sell rate on a rebilled client, where usage past the included amount is billed instead.`
          : `Removed the usage-limit override on “${name}” — the plan's included allowances (if any) apply again.`,
        ref: { kind: "subAccount", id: snap.id },
      };
    },
  },
  // AI live booking setup. All three run only on ctx.subAccountId (no
  // workspace parameter exists); the agency variants re-anchor through
  // inSubAccount().
  {
    name: "create_booking_page",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    menuLabel:
      "Create and publish a simple booking page (name, meeting length, available days and hours)",
    description:
      "Create a booking page in THIS workspace and publish it straight away, so people (and the AI agents) can book on it. Gather from the user: a name (e.g. 'Free consultation'), where the meeting happens (video link, Google Meet, in person at an address, a phone call either way, or at the booker's address), the meeting length, the days and hours they're available, and optionally a short description, a meeting link and the timezone (defaults to the AI agent's timezone). It's a single shared schedule with no deposit, email reminders on, 14 days bookable ahead and 2 hours' minimum notice; deposits, team members, intake questions and styling are added later in the Booking page editor. Check ai_booking_readiness first so you don't create a duplicate of a page that already exists. After it's created, offer configure_ai_booking to let the AI book on it.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Page name shown to visitors, e.g. 'Free 30-minute consultation' (≤80 chars)." },
        durationMinutes: {
          type: "integer",
          enum: [15, 30, 45, 60, 75, 90, 120],
          description: "Meeting length in minutes. Default 30.",
        },
        days: {
          type: "array",
          items: { type: "string", enum: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] },
          description: "Days they take bookings. Default Monday to Friday.",
        },
        startTime: { type: "string", description: "Daily start time, 24h HH:MM. Default 09:00." },
        endTime: { type: "string", description: "Daily end time, 24h HH:MM (24:00 = midnight). Default 17:00." },
        timezone: { type: "string", description: "IANA timezone, e.g. 'Australia/Sydney'. Omit to use the AI agent's timezone." },
        description: { type: "string", description: "Optional short text shown above the time picker (≤2000 chars)." },
        locationType: {
          type: "string",
          enum: ["video_link", "google_meet", "in_person", "we_call", "they_call", "their_address"],
          description:
            "Where the meeting happens: video_link (Zoom/Teams link — needs meetingUrl), google_meet (unique Meet link per booking), in_person (at the business — needs locationValue = address), we_call (business phones the booker), they_call (booker phones the business — needs locationValue = number), their_address (at the booker's address, asked when they book). Ask the user; don't guess.",
        },
        locationValue: { type: "string", description: "The address (in_person) or phone number to call (they_call). Omit otherwise." },
        meetingUrl: { type: "string", description: "Video meeting link (https). Required for video_link; optional fallback for google_meet." },
      },
      required: ["name", "locationType"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const name = str(raw, "name");
      if (!name || name.length > 80) {
        return { ok: false, error: "a page name (1–80 characters) is required" };
      }
      const r = (raw ?? {}) as Record<string, unknown>;
      // A given-but-unreadable value is an error, never a silent default.
      if (r.durationMinutes != null && num(raw, "durationMinutes") === null) {
        return { ok: false, error: "durationMinutes must be a number of minutes" };
      }
      const durationMinutes = num(raw, "durationMinutes") ?? 30;
      if (![15, 30, 45, 60, 75, 90, 120].includes(durationMinutes)) {
        return { ok: false, error: "durationMinutes must be 15, 30, 45, 60, 75, 90 or 120" };
      }
      if (r.days != null && !Array.isArray(r.days)) {
        return { ok: false, error: "days must be a list, e.g. [\"mon\",\"tue\"]" };
      }
      const dayNames = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
      const days = Array.isArray(r.days)
        ? [...new Set((r.days as unknown[]).map((d) => String(d).trim().toLowerCase()))]
        : ["mon", "tue", "wed", "thu", "fri"];
      if (days.length === 0 || days.some((d) => !dayNames.includes(d))) {
        return { ok: false, error: "days must be from mon, tue, wed, thu, fri, sat, sun" };
      }
      const toMinutes = (v: string): number | null => {
        const m = /^(\d{1,2}):(\d{2})$/.exec(v);
        if (!m) return null;
        const mins = Number(m[1]) * 60 + Number(m[2]);
        return Number(m[2]) < 60 && mins <= 1440 ? mins : null;
      };
      const startMinute = toMinutes(str(raw, "startTime") || "09:00");
      const endMinute = toMinutes(str(raw, "endTime") || "17:00");
      if (startMinute === null || endMinute === null || endMinute <= startMinute) {
        return { ok: false, error: "startTime and endTime must be HH:MM with the end after the start" };
      }
      if (endMinute - startMinute < durationMinutes) {
        return { ok: false, error: "the daily hours are shorter than one meeting" };
      }
      const description = str(raw, "description");
      if (description.length > 2000) {
        return { ok: false, error: "description must be 2000 characters or fewer" };
      }
      // Same checks the booking validator runs, so a bad value fails before the confirm card.
      const timezone = str(raw, "timezone") || null;
      if (timezone) {
        const tz = validateTimezone(timezone);
        if (!tz.ok) return { ok: false, error: tz.error };
      }
      const meetingUrl = str(raw, "meetingUrl") || null;
      if (meetingUrl) {
        const mu = validateMeetingUrl(meetingUrl);
        if (!mu.ok) return { ok: false, error: mu.error };
      }
      // Same location rules as the Booking editor (validateBookingLocation).
      const loc = validateBookingLocation({
        type: str(raw, "locationType"),
        value: str(raw, "locationValue") || null,
      });
      if (!loc.ok || !loc.value) {
        return { ok: false, error: loc.ok ? "locationType is required" : loc.error };
      }
      if (loc.value.type === "video_link" && !meetingUrl) {
        return { ok: false, error: "a video_link page needs meetingUrl (the Zoom/Teams link)" };
      }
      return {
        ok: true,
        args: {
          name,
          durationMinutes,
          days,
          startMinute,
          endMinute,
          timezone,
          description,
          meetingUrl,
          location: loc.value,
        },
      };
    },
    summarize: (args) => {
      const hhmm = (m: number) =>
        `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
      return `Create and publish booking page “${args.name as string}”: ${args.durationMinutes as number}-min meetings, ${(args.days as string[]).join("/")} ${hhmm(args.startMinute as number)}–${hhmm(args.endMinute as number)} (${args.timezone ? (args.timezone as string) : "the AI agent's timezone, else UTC"}), ${describeBookingLocation(args.location as Parameters<typeof describeBookingLocation>[0]) ?? "location not set"}, no deposit.`;
    },
    execute: async (ctx, args) => {
      const subAccountId = ctx.subAccountId!;
      const db = getAdminDb();
      const [profileSnap, pagesSnap] = await Promise.all([
        db.doc(`subAccounts/${subAccountId}/aiAgent/profile`).get(),
        db.collection(`subAccounts/${subAccountId}/bookingPages`).get(),
      ]);
      const timezone =
        (args.timezone as string | null) ||
        (profileSnap.data()?.timezone as string | undefined) ||
        "UTC";

      // Readable, unique slug from the name; the create() call still guards races.
      const taken = new Set(pagesSnap.docs.map((d) => d.id));
      const base =
        (args.name as string)
          // "Café" -> "cafe" rather than "caf".
          .normalize("NFKD")
          .replace(/[̀-ͯ]/g, "")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 40)
          .replace(/-+$/g, "") || "booking";
      const safeBase = ["new", "edit", "settings", "api"].includes(base) ? `${base}-page` : base;
      let slug = safeBase;
      for (let i = 2; taken.has(slug) && i < 100; i++) slug = `${safeBase}-${i}`;

      const dayIndex: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
      const body = {
        ...defaultBookingPageFormData(slug, timezone),
        name: args.name as string,
        description: args.description as string,
        status: "published",
        durationMinutes: args.durationMinutes as number,
        workingHours: (args.days as string[])
          .map((d) => dayIndex[d])
          .sort((a, b) => a - b)
          .map((dayOfWeek) => ({
            dayOfWeek,
            startMinute: args.startMinute as number,
            endMinute: args.endMinute as number,
          })),
        meetingUrl: args.meetingUrl as string | null,
        location: args.location,
        googleMeet: (args.location as { type: string }).type === "google_meet",
      };
      const result = await createBookingPageForSubAccount({
        subAccountId,
        uid: ctx.uid,
        body,
      });
      if (!result.ok) throw new CapabilityUserError(result.error);
      const appBase = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
      const publicUrl = appBase ? `${appBase}/b/${subAccountId}/${result.slug}` : null;
      return {
        resultText: `Created and published booking page “${args.name as string}” (slug: ${result.slug}, timezone ${timezone}).${publicUrl ? ` Public link: ${publicUrl}` : ""} To let the AI agents book on it, use configure_ai_booking with this slug.`,
        ref: { kind: "bookingPage", id: result.slug },
      };
    },
  },
  {
    name: "ai_booking_readiness",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    menuLabel:
      "Check whether the AI agents can book appointments in this workspace (per channel, booking pages, email, reminders)",
    description:
      "Readiness report for AI live booking in THIS workspace: for Web Chat (typed + Web Voice), phone (inbound Voice) and messaging (SMS / WhatsApp / Messenger & Instagram) — whether the channel is enabled and unlocked by the agency, which booking page it books on and whether that page is bookable, plus the persona, AI key, confirmation email, reminders, the 'ask the booking page's questions' switch, and the booking pages the AI can use (with their intake question counts). ALWAYS run this first when the user asks to let the AI book, reschedule or cancel appointments, or asks why AI booking isn't working, and before configure_ai_booking.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "Check AI booking readiness.",
    execute: async (ctx) => {
      try {
        return { resultText: await getAiBookingReadiness(ctx.subAccountId!) };
      } catch (err) {
        if (err instanceof AiBookingSetupError) throw new CapabilityUserError(err.message);
        throw err;
      }
    },
  },
  {
    name: "configure_ai_booking",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    menuLabel:
      "Choose the booking page the AI books on (Web Chat, phone, messaging) or switch booking questions on/off",
    description:
      "Set which booking page the AI agents book appointments on in THIS workspace, per channel: webChatPage (Web Chat typed + Web Voice), voicePage (inbound phone calls), messagingPage (SMS, WhatsApp, Messenger & Instagram). Pass a page's slug from ai_booking_readiness, or an empty string to switch booking off for that channel (the AI then shares the booking link). askIntake turns 'ask the booking page's questions before booking' on/off for every channel. Only send the fields being changed. Setting a channel's page also lets the AI move and cancel appointments on that channel, except phone, where callers can only change bookings once the admin ticks 'Let callers move or cancel their upcoming bookings' under AI Agents → Voice (this tool can't set that). Pages must be published and take no deposit. This does NOT enable channels themselves — if ai_booking_readiness says a channel is off or locked, tell the user where to fix it.",
    parameters: {
      type: "object",
      properties: {
        webChatPage: {
          type: "string",
          description: "Booking page slug for Web Chat, or an empty string to switch Web Chat booking off.",
        },
        voicePage: {
          type: "string",
          description: "Booking page slug for inbound phone calls, or an empty string to switch phone booking off.",
        },
        messagingPage: {
          type: "string",
          description: "Booking page slug for SMS / WhatsApp / Messenger & Instagram, or an empty string to switch it off.",
        },
        askIntake: {
          type: "boolean",
          description: "Ask the booking page's intake questions before booking (all channels).",
        },
      },
      additionalProperties: false,
    },
    validate: (raw) => {
      const r = (raw ?? {}) as Record<string, unknown>;
      const args: Record<string, unknown> = {};
      for (const key of ["webChatPage", "voicePage", "messagingPage"] as const) {
        if (!(key in r)) continue;
        const v = r[key];
        if (v === null || (typeof v === "string" && v.trim() === "")) {
          args[key] = null;
        } else if (typeof v === "string" && SLUG_RE.test(v.trim()) && v.trim().length <= 80) {
          args[key] = v.trim();
        } else {
          return { ok: false, error: `${key} must be a booking page slug from ai_booking_readiness, or an empty string to switch it off` };
        }
      }
      if ("askIntake" in r) {
        if (typeof r.askIntake !== "boolean") {
          return { ok: false, error: "askIntake must be true or false" };
        }
        args.askIntake = r.askIntake;
      }
      if (Object.keys(args).length === 0) {
        return { ok: false, error: "nothing to change — give at least one setting" };
      }
      return { ok: true, args };
    },
    summarize: (args) => {
      const parts: string[] = [];
      const page = (label: string, v: unknown) => {
        if (v === undefined) return;
        parts.push(v ? `${label} books on “${v as string}”` : `${label} booking OFF`);
      };
      page("Web Chat", args.webChatPage);
      page("phone", args.voicePage);
      page("SMS/WhatsApp/Messenger", args.messagingPage);
      if (args.askIntake !== undefined) {
        parts.push(`booking questions ${args.askIntake ? "ON" : "OFF"}`);
      }
      return `AI booking: ${parts.join(", ")}.`;
    },
    execute: async (ctx, args) => {
      try {
        const changes = await configureAiBooking(ctx.subAccountId!, {
          webChatPage: args.webChatPage as string | null | undefined,
          voicePage: args.voicePage as string | null | undefined,
          messagingPage: args.messagingPage as string | null | undefined,
          askIntake: args.askIntake as boolean | undefined,
        });
        return {
          resultText: `Done: ${changes.join("; ")}. Run ai_booking_readiness to confirm each channel is ready.`,
        };
      } catch (err) {
        if (err instanceof AiBookingSetupError) throw new CapabilityUserError(err.message);
        throw err;
      }
    },
  },
  // Speed-to-Lead setup: readiness, form, workflow, website, test
  {
    name: "speed_to_lead_readiness",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    menuLabel:
      "Check whether this workspace is ready for speed-to-lead (email, SMS, WhatsApp, forms, workflows, website)",
    description:
      "Readiness report for an instant-lead-response (speed-to-lead) setup in this workspace: whether email, SMS, and WhatsApp can actually send, whether delayed steps can run, who gets team notifications, which forms and form-triggered workflows already exist, which websites exist and what their call-to-action points at, and this month's usage against any caps. ALWAYS run this first when the user asks to set up speed-to-lead, an instant reply to new leads, or a form auto-response — and before proposing any SMS/WhatsApp step, so you never build a step that can't send.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "Check speed-to-lead readiness.",
    execute: async (ctx) => {
      const db = getAdminDb();
      const subAccountId = ctx.subAccountId!;
      const subSnap = await db.doc(`subAccounts/${subAccountId}`).get();
      if (!subSnap.exists) {
        throw new CapabilityUserError("This workspace couldn't be loaded.");
      }
      const sub = subSnap.data() as Record<string, unknown>;
      const agencyId = (sub.agencyId as string) || ctx.agencyId;
      const [
        agencySnap,
        forms,
        workflows,
        siteSnap,
        waSnap,
        usageSnap,
        pushPrefsSnap,
        pushSubsSnap,
      ] = await Promise.all([
        db.doc(`agencies/${agencyId}`).get(),
        listFormsForSubAccount(subAccountId),
        listWorkflows(subAccountId),
        db.collection(`subAccounts/${subAccountId}/website`).get(),
        db
          .collection(`subAccounts/${subAccountId}/whatsappTemplates`)
          .where("status", "==", "approved")
          .get(),
        db.doc(`subAccounts/${subAccountId}/usage/${usageMonthKey()}`).get(),
        // The caller's own push settings, so the report says whether they'll be alerted.
        db.doc(`users/${ctx.uid}/settings/notifications`).get(),
        db.collection(`users/${ctx.uid}/pushSubscriptions`).get(),
      ]);
      const agency = (agencySnap.data() ?? {}) as Record<string, unknown>;
      const twilio = (sub.twilioConfig ?? null) as TwilioConfig | null;
      const resend = (sub.resendConfig ?? null) as {
        domainName?: string;
        status?: string;
        inboxEnabled?: boolean;
      } | null;
      const lines: string[] = [];
      const mark = (ready: boolean) => (ready ? "READY" : "NOT READY");

      // Email
      const emailDeployment = emailIsConfigured();
      const domainVerified = resend?.status === "verified";
      const replyTo = ((sub.replyToEmail as string) ?? "").trim();
      const emailReady = emailDeployment;
      lines.push(
        `EMAIL: ${mark(emailReady)} — ${
          !emailDeployment
            ? "the deployment has no email provider configured (agency/setup task: Resend key + sender). Email steps will be skipped."
            : domainVerified
              ? `sends from the workspace's own verified domain ${resend?.domainName}${resend?.inboxEnabled ? " with the two-way inbox ON (replies land in Conversations)" : ""}.`
              : "sends from the platform's shared sender (a dedicated sending domain can be set up under Settings → Messaging tab → Email sending domain)."
        }${
          emailDeployment
            ? replyTo
              ? ` Reply-To is ${replyTo}.`
              : " Reply-To is NOT set — replies to automated emails would bounce; set it under Settings → Messaging tab → Sending preferences."
            : ""
        }`
      );

      // SMS
      const dedicated = subAccountTwilioIsConfigured(twilio);
      const sharedAllowed = agency.sharedSmsAllowed !== false;
      const sharedSms = !dedicated && sharedAllowed && smsIsConfigured();
      const smsReady = dedicated || sharedSms;
      lines.push(
        `SMS: ${mark(smsReady)} — ${
          dedicated
            ? `dedicated Twilio number ${twilio?.fromNumber} (two-way threads + STOP/START handled).`
            : sharedSms
              ? "no dedicated number; falls back to the platform's shared sender (one-way — replies can't be routed back). Fix: Settings → Messaging tab → SMS → enable a dedicated Twilio number."
              : !sharedAllowed
                ? "the agency requires each workspace to bring its own Twilio number and none is configured. Fix: Settings → Messaging tab → SMS → paste the workspace's Twilio Account SID, Auth Token, and From number."
                : "no Twilio number configured anywhere. Fix: Settings → Messaging tab → SMS → enable a dedicated Twilio number (or the agency sets shared Twilio keys on the deployment). SMS steps will be skipped until then."
        }`
      );

      // WhatsApp
      const waGate = sub.whatsappEnabledByAgency === true;
      const waSender = subAccountWhatsappIsConfigured(twilio);
      const approved = waSnap.docs.map((d) => ({
        id: d.id,
        name:
          ((d.data().displayName as string) || (d.data().name as string)) ??
          d.id,
      }));
      const waReady = waGate && waSender && approved.length > 0;
      lines.push(
        `WHATSAPP: ${mark(waReady)} — ${
          !waGate
            ? "the agency WhatsApp gate is OFF for this workspace (agency owner: Agency → Sub-accounts → Manage). Leave WhatsApp out of the flow."
            : !waSender
              ? "gate is on but no WhatsApp sender is configured (Settings → Messaging tab → SMS → WhatsApp sender). Leave WhatsApp out for now."
              : approved.length === 0
                ? "sender is configured but there are NO approved templates yet — a workflow can only send Meta-approved templates. Create one under AI Agents → WhatsApp → Templates and wait for approval; leave WhatsApp out for now."
                : `approved templates available: ${approved
                    .slice(0, 8)
                    .map((t) => `“${t.name}” (id ${t.id})`)
                    .join(", ")}.`
        }`
      );

      // Queue
      const queue = qstashIsConfigured();
      lines.push(
        `DELAYED STEPS / QUEUE: ${mark(queue)} — ${
          queue
            ? "background queue is configured; waits, reply timeouts, and reminders will run."
            : "the deployment has no QStash configured (agency/setup task). Instant steps still run when a form is submitted, but any wait / wait-for-reply step will never advance."
        }`
      );

      // Team notification
      const contactEmail = (
        (sub.accountContact as { email?: string } | null)?.email ?? ""
      ).trim();
      lines.push(
        `TEAM NOTIFICATIONS: ${
          contactEmail
            ? `business contact email is ${contactEmail} (a 'notify team' step can use it).`
            : "no business contact email is set (Settings → Admin tab → Business contact) — 'notify team' steps fall back to the agency owner's email, or use a custom address."
        }`
      );

      // Team push alerts fire the moment a form is submitted.
      const pushConfigured = pushIsConfigured();
      const pushPref = (
        (pushPrefsSnap.data()?.subAccounts as Record<string, boolean> | undefined) ?? {}
      )[subAccountId];
      const devices = pushSubsSnap.size;
      const pushOnHere = devices > 0 && pushPref !== false;
      lines.push(
        `NEW-LEAD PUSH ALERTS (you): ${mark(pushOnHere)} — ${
          !pushConfigured
            ? "push notifications aren't set up on this deployment (agency/setup task: VAPID keys + redeploy). You'll rely on the 'notify team' email step instead."
            : devices === 0
              ? "you have no device enabled yet. Turn it on: top-right account menu → Your account → Notifications → allow the browser prompt → tick this workspace. On iPhone/iPad, first add the app to the Home Screen (Share → Add to Home Screen), open it from there, then enable. Each phone/computer is enabled separately."
              : pushPref === false
                ? `you have ${devices} device${devices === 1 ? "" : "s"} enabled but THIS workspace is switched off in your Notifications settings — tick it under Your account → Notifications.`
                : `on for ${devices} device${devices === 1 ? "" : "s"} — you'll get a push the moment a lead comes in (new lead, inbound message, booking, missed call).`
        }`
      );

      // Forms
      if (forms.length === 0) {
        lines.push(
          "FORMS: none yet — create one (ask me: create_form with the 'contact' preset) or build one under Sidebar → Forms."
        );
      } else {
        lines.push(
          `FORMS (${forms.length}):\n${forms
            .slice(0, 12)
            .map(
              (f) =>
                `  - “${f.name}”${f.enabled ? "" : " (disabled)"} — ${f.submissionCount ?? 0} submissions, id: ${f.id}, public URL: ${formPublicUrl(f.id)}`
            )
            .join("\n")}`
        );
      }

      // Existing form-triggered workflows
      const formWfs = workflows.filter(
        (w) => w.trigger?.type === "form.submitted"
      );
      if (formWfs.length === 0) {
        lines.push(
          "FORM-TRIGGERED WORKFLOWS: none yet — create one from the speed-to-lead template (create_workflow) pinned to the chosen form."
        );
      } else {
        lines.push(
          `FORM-TRIGGERED WORKFLOWS (${formWfs.length}) — don't create a duplicate; configure or publish these instead:\n${formWfs
            .map((w) => {
              const fid = w.trigger?.formId ?? null;
              const fname = fid
                ? forms.find((f) => f.id === fid)?.name ?? fid
                : "ANY form";
              return `  - “${w.name}” — ${w.status}${w.startNodeId ? "" : ", no steps"}, form: ${fname}, id: ${w.id}`;
            })
            .join("\n")}`
        );
      }
      if (sub.automationsPaused === true) {
        lines.push(
          "⚠️ 'Pause all workflows' is ON — nothing fires until it's resumed (Settings → Messaging tab → Sending preferences)."
        );
      }

      // Websites
      if (siteSnap.empty) {
        lines.push(
          "WEBSITE: none built here. If the client's site lives elsewhere, give them the form's embed snippet or public URL to link from the site."
        );
      } else {
        lines.push(
          `WEBSITES (${siteSnap.size}):\n${siteSnap.docs
            .map((d) => {
              const w = d.data() as Record<string, unknown>;
              const cfg = (w.config ?? {}) as { heading?: string; cta_link?: string };
              const name = (w.name as string) || cfg.heading || "Untitled site";
              const status = w.status as string;
              const cta = (cfg.cta_link ?? "").trim();
              const pointsAtForm =
                cta && forms.some((f) => cta.includes(`/f/${f.id}`));
              return `  - “${name}” — ${status}${w.liveUrl ? `, live at ${w.liveUrl}` : ""}; call-to-action: ${cta || "none"}${pointsAtForm ? " (already points at a form ✓)" : cta ? " (does NOT point at a form — update_website_cta can fix that)" : ""}; id: ${d.id}`;
            })
            .join("\n")}`
        );
      }

      // Usage vs caps
      const usage = (usageSnap.data() ?? {}) as UsageMonthDoc;
      const effective = await getEffectiveBilling(subAccountId, {
        ...(sub as Record<string, unknown>),
        agencyId,
      } as Parameters<typeof getEffectiveBilling>[1]);
      const quotas = effective.quotas;
      // A rebilled client with rates keeps sending past its included amount (billed instead).
      const pastNote =
        effective.rebilling && effective.rates
          ? " — past the included amount (billed if the channel has a rate, else paused)"
          : " — CAPPED, that channel is paused until the month resets";
      const capLine = (label: string, used: number, limit?: number | null) =>
        typeof limit === "number" && limit > 0
          ? `${label} ${used}/${limit}${used >= limit ? pastNote : ""}`
          : `${label} ${used} (no cap)`;
      lines.push(
        `USAGE THIS MONTH: ${[
          capLine("emails", usage.emailsSent ?? 0, quotas?.emailsPerMonth),
          capLine("SMS", usage.smsSegments ?? 0, quotas?.smsSegmentsPerMonth),
          capLine("WhatsApp", usage.whatsappMessages ?? 0, quotas?.whatsappPerMonth),
        ].join("; ")}.`
      );

      return {
        resultText: `Speed-to-lead readiness for this workspace:\n${lines.join("\n")}\nRecommended order: fix or accept the channel status above → pick or create the form → create the workflow pinned to that form → configure its steps → publish → point the website's call-to-action at the form (or share the embed snippet) → make sure the team's new-lead push alerts are on → run a test on yourself.`,
      };
    },
  },
  {
    name: "list_forms",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    menuLabel: "See your forms with their public links and embed snippets",
    description:
      "List this workspace's forms with id, name, enabled flag, submission count, public URL, and iframe embed snippet. Use to answer 'what forms do I have / what's my form link / how do I embed it', and ALWAYS to resolve a form's id before create_workflow (formId) or configure_workflow — never guess ids.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "List forms.",
    execute: async (ctx) => {
      const forms = await listFormsForSubAccount(ctx.subAccountId!);
      if (forms.length === 0) {
        return {
          resultText:
            "No forms in this workspace yet. Ask me to create one (create_form, 'contact' preset: name, email, phone, message) or build one under Sidebar → Forms.",
        };
      }
      const lines = forms.slice(0, 20).map(
        (f) =>
          `- “${f.name}”${f.enabled ? "" : " (disabled)"} — ${f.submissionCount ?? 0} submissions, ${f.fields?.length ?? 0} fields, id: ${f.id}\n  public URL: ${formPublicUrl(f.id)}\n  embed: ${formEmbedSnippet(f.id)}`
      );
      const more =
        forms.length > 20 ? `\n(+${forms.length - 20} more — see the Forms page)` : "";
      return { resultText: `Forms (${forms.length}):\n${lines.join("\n")}${more}` };
    },
  },
  {
    name: "create_form",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    menuLabel: "Create a lead form from a preset (Contact form: name, email, phone, message)",
    description:
      "Create a new public lead-capture form in this workspace from a preset. 'contact' = Full name, Email, Phone, and a required 'How can we help?' message (the usual website contact form). 'blank' = Full name, Email, Phone, Company. Returns the public URL and the iframe embed snippet. Run list_forms first so you don't create a duplicate. Custom field layouts are edited on the Forms page afterwards.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The form's name, e.g. 'Contact us' or 'Free quote request'. Ask the user if they haven't given one — don't invent it.",
        },
        template: {
          type: "string",
          enum: ["contact", "blank"],
          description: "Preset to start from. Default 'contact'.",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const name = str(raw, "name");
      if (!name) return { ok: false, error: "a form name is required" };
      if (name.length > 80) return { ok: false, error: "form name is too long (80 chars max)" };
      const template = str(raw, "template") || "contact";
      if (!["contact", "blank"].includes(template)) {
        return { ok: false, error: "template must be 'contact' or 'blank'" };
      }
      return { ok: true, args: { name, template } };
    },
    summarize: (args) =>
      `Create a form “${args.name}” from the ${args.template === "contact" ? "Contact form" : "Blank"} preset.`,
    execute: async (ctx, args) => {
      const name = args.name as string;
      const existing = await listFormsForSubAccount(ctx.subAccountId!);
      const dup = existing.find(
        (f) => f.name.trim().toLowerCase() === name.toLowerCase()
      );
      if (dup) {
        throw new CapabilityUserError(
          `A form named “${dup.name}” already exists (id ${dup.id}, public URL ${formPublicUrl(dup.id)}). Use that one, or pick a different name.`
        );
      }
      let id: string;
      try {
        id = await createFormServerSide({
          subAccountId: ctx.subAccountId!,
          createdByUid: ctx.uid,
          name,
          template: args.template as "contact" | "blank",
        });
      } catch (err) {
        if (err instanceof FormServiceError) throw new CapabilityUserError(err.message);
        throw err;
      }
      return {
        resultText: `Created the form “${name}” (id ${id}). Public URL: ${formPublicUrl(id)}\nEmbed on a website: ${formEmbedSnippet(id)}\nSubmissions create a contact automatically; pin a workflow to this form to respond instantly.`,
        ref: { kind: "form", id },
      };
    },
  },
  {
    name: "configure_workflow",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    menuLabel:
      "Set a workflow's steps (SMS, email, WhatsApp template, wait, task, notify) and the form it listens to",
    description:
      "Configure a DRAFT or PAUSED workflow in this workspace: optionally pin it to one form (formId from list_forms), rename it, set re-enrollment, and/or REPLACE its steps with a linear list you build from the user's wording. Step types: send_sms (body), send_email (subject + body — body MUST contain {{unsubscribeLink}}), whatsapp_template (templateId of an APPROVED template from speed_to_lead_readiness), wait (waitSeconds), create_task (title, dueInDays), notify (team email: recipient owner | account_contact | custom + to). Merge tags like {{contact.firstName}} and {{bookingLink}} work in bodies. Refuses ACTIVE workflows — pause first (set_workflow_status) or the user edits in the builder. Branching (if/else, wait-for-reply) is builder-only. Resolve the workflow id with list_workflows first — never guess ids. Only include SMS/WhatsApp steps when readiness said that channel is READY.",
    parameters: {
      type: "object",
      properties: {
        workflowId: {
          type: "string",
          description: "The workflow's id, exactly as returned by list_workflows or create_workflow.",
        },
        workflowName: {
          type: "string",
          description: "The workflow's current name, for the confirmation card.",
        },
        name: { type: "string", description: "Optional new name." },
        formId: {
          type: "string",
          description: "Optional: the form this workflow should fire for (id from list_forms). Sets the trigger to 'form submitted' for that form only.",
        },
        formName: { type: "string", description: "The form's name (when formId is set)." },
        reentry: {
          type: "string",
          enum: ["every_time", "unless_active", "once_ever"],
          description: "Optional re-enrollment policy. Default for speed-to-lead: every_time.",
        },
        steps: {
          type: "array",
          maxItems: 12,
          description:
            "Optional ordered list of steps that REPLACES the workflow's current steps. Omit to keep the existing steps.",
          items: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: ["send_sms", "send_email", "whatsapp_template", "wait", "create_task", "notify"],
              },
              body: { type: "string", description: "send_sms / send_email / notify message text." },
              subject: { type: "string", description: "send_email / notify subject." },
              templateId: { type: "string", description: "whatsapp_template: id of an approved template." },
              templateName: { type: "string", description: "whatsapp_template: the template's name, for the card." },
              waitSeconds: {
                type: "number",
                description: "wait: seconds to pause (60 = 1 minute, 3600 = 1 hour, 86400 = 1 day).",
              },
              title: { type: "string", description: "create_task: the task title." },
              dueInDays: { type: "number", description: "create_task: due in N days (default 1)." },
              recipient: {
                type: "string",
                enum: ["owner", "account_contact", "custom"],
                description: "notify: who gets the internal email (default account_contact).",
              },
              to: { type: "string", description: "notify: custom email address (when recipient is custom)." },
            },
            required: ["type"],
            additionalProperties: false,
          },
        },
      },
      required: ["workflowId", "workflowName"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const workflowId = str(raw, "workflowId");
      if (!workflowId) {
        return { ok: false, error: "the workflow id is required — look it up first (list_workflows)" };
      }
      const reentry = str(raw, "reentry");
      if (reentry && !["every_time", "unless_active", "once_ever"].includes(reentry)) {
        return { ok: false, error: "reentry must be every_time, unless_active, or once_ever" };
      }
      const rawSteps = (raw as Record<string, unknown>)?.steps;
      let steps: Record<string, unknown>[] | null = null;
      if (rawSteps !== undefined) {
        if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
          return { ok: false, error: "steps must be a non-empty list (omit it to keep the current steps)" };
        }
        if (rawSteps.length > 12) return { ok: false, error: "12 steps max" };
        steps = [];
        for (const [i, s] of rawSteps.entries()) {
          const type = str(s, "type");
          const n = i + 1;
          switch (type) {
            case "send_sms": {
              const body = str(s, "body");
              if (!body) return { ok: false, error: `step ${n} (SMS) needs a body` };
              if (body.length > 320) return { ok: false, error: `step ${n} (SMS) body is over 320 characters` };
              steps.push({ type, body });
              break;
            }
            case "send_email": {
              const subject = str(s, "subject");
              const body = str(s, "body");
              if (!subject || !body) return { ok: false, error: `step ${n} (email) needs a subject and a body` };
              const err = validateEmailBody(body);
              if (err) return { ok: false, error: `step ${n} (email): ${err}` };
              steps.push({ type, subject, body });
              break;
            }
            case "whatsapp_template": {
              const templateId = str(s, "templateId");
              if (!templateId) return { ok: false, error: `step ${n} (WhatsApp) needs the id of an approved template` };
              steps.push({ type, templateId, templateName: str(s, "templateName") });
              break;
            }
            case "wait": {
              const secs = num(s, "waitSeconds");
              if (!secs || secs < 60 || secs > 30 * 86_400) {
                return { ok: false, error: `step ${n} (wait) needs waitSeconds between 60 and 2592000 (30 days)` };
              }
              steps.push({ type, waitSeconds: Math.round(secs) });
              break;
            }
            case "create_task": {
              const title = str(s, "title");
              if (!title) return { ok: false, error: `step ${n} (task) needs a title` };
              const due = num(s, "dueInDays");
              steps.push({ type, title, dueInDays: due && due > 0 ? Math.round(due) : 1 });
              break;
            }
            case "notify": {
              const recipient = str(s, "recipient") || "account_contact";
              if (!["owner", "account_contact", "custom"].includes(recipient)) {
                return { ok: false, error: `step ${n} (notify) recipient must be owner, account_contact, or custom` };
              }
              const to = str(s, "to");
              if (recipient === "custom" && !EMAIL_RE.test(to)) {
                return { ok: false, error: `step ${n} (notify) needs a valid custom email address` };
              }
              steps.push({
                type,
                recipient,
                to: recipient === "custom" ? to : "",
                subject: str(s, "subject") || "New lead from your form",
                body:
                  str(s, "body") ||
                  "{{contact.name}} ({{contact.email}} · {{contact.phone}}) just submitted a form.",
              });
              break;
            }
            default:
              return { ok: false, error: `step ${n}: unknown type '${type}'` };
          }
        }
      }
      return {
        ok: true,
        args: {
          workflowId,
          workflowName: str(raw, "workflowName"),
          name: str(raw, "name"),
          formId: str(raw, "formId"),
          formName: str(raw, "formName"),
          reentry,
          steps,
        },
      };
    },
    summarize: (args) => {
      const parts: string[] = [];
      if (args.name) parts.push(`rename to “${args.name}”`);
      if (args.formId) parts.push(`trigger only on the “${args.formName || args.formId}” form`);
      if (args.reentry) parts.push(`re-enrollment: ${String(args.reentry).replace("_", " ")}`);
      const steps = args.steps as Record<string, unknown>[] | null;
      if (steps) {
        const labels = steps.map((s) => {
          switch (s.type) {
            case "send_sms": return "SMS";
            case "send_email": return `email “${s.subject}”`;
            case "whatsapp_template": return `WhatsApp “${s.templateName || s.templateId}”`;
            case "wait": {
              const secs = s.waitSeconds as number;
              return secs % 86_400 === 0 ? `wait ${secs / 86_400}d` : secs % 3600 === 0 ? `wait ${secs / 3600}h` : `wait ${Math.round(secs / 60)}m`;
            }
            case "create_task": return `task “${s.title}”`;
            case "notify": return `notify ${s.recipient === "custom" ? s.to : String(s.recipient).replace("_", " ")}`;
            default: return String(s.type);
          }
        });
        parts.push(`steps: ${labels.join(" → ")}`);
      }
      return `Configure the workflow “${args.workflowName || args.workflowId}” — ${parts.join("; ") || "no changes"}.`;
    },
    execute: async (ctx, args) => {
      const wf = await getWorkflow(ctx.subAccountId!, args.workflowId as string);
      if (!wf) throw new CapabilityUserError("That workflow wasn't found in this workspace.");
      if (wf.status === "active") {
        throw new CapabilityUserError(
          `“${wf.name}” is live. Pause it first (ask me, or use the Workflows page), then configure it, then publish again.`
        );
      }
      const patch: Parameters<typeof updateWorkflowServerSide>[0]["patch"] = {};
      const name = (args.name as string) || "";
      if (name) patch.name = name;
      const reentry = (args.reentry as string) || "";
      if (reentry) patch.reentry = reentry as WorkflowReentry;
      const formId = (args.formId as string) || "";
      let formLabel = "";
      if (formId) {
        const form = await getFormForSubAccount(ctx.subAccountId!, formId);
        if (!form) throw new CapabilityUserError("That form wasn't found in this workspace — check list_forms.");
        formLabel = form.name;
        patch.trigger = { ...wf.trigger, type: "form.submitted", formId };
      }
      const steps = args.steps as Record<string, unknown>[] | null;
      if (steps) {
        // Re-anchor templates and require approval up front (the engine also
        // refuses unapproved ones at run time).
        for (const s of steps) {
          if (s.type !== "whatsapp_template") continue;
          const t = await getAdminDb()
            .doc(`subAccounts/${ctx.subAccountId!}/whatsappTemplates/${s.templateId as string}`)
            .get();
          if (!t.exists) {
            throw new CapabilityUserError(`WhatsApp template ${s.templateId} wasn't found in this workspace.`);
          }
          if (t.data()?.status !== "approved") {
            throw new CapabilityUserError(
              `WhatsApp template “${t.data()?.displayName ?? s.templateId}” isn't approved yet (status: ${t.data()?.status}). Only approved templates can be sent from a workflow.`
            );
          }
        }
        const nodes: Record<string, WorkflowNode> = {};
        steps.forEach((s, i) => {
          const id = `n${i + 1}`;
          const next = i + 1 < steps.length ? `n${i + 2}` : null;
          let config: Record<string, unknown>;
          switch (s.type) {
            case "send_sms": config = { body: s.body }; break;
            case "send_email": config = { subject: s.subject, body: s.body }; break;
            case "whatsapp_template": config = { templateId: s.templateId, manualValues: {} }; break;
            case "wait": config = { seconds: s.waitSeconds }; break;
            case "create_task": config = { title: s.title, dueInDays: s.dueInDays }; break;
            default: config = { recipient: s.recipient, to: s.to, subject: s.subject, body: s.body };
          }
          nodes[id] = { id, type: s.type as WorkflowNode["type"], config, next };
        });
        patch.nodes = nodes;
        patch.startNodeId = "n1";
      }
      if (Object.keys(patch).length === 0) {
        return { resultText: `Nothing to change on “${wf.name}”.`, ref: { kind: "workflow", id: wf.id } };
      }
      const ok = await updateWorkflowServerSide({
        subAccountId: ctx.subAccountId!,
        workflowId: wf.id,
        patch,
      });
      if (!ok) throw new CapabilityUserError("That workflow couldn't be updated.");
      const bits: string[] = [];
      if (name) bits.push(`renamed to “${name}”`);
      if (formId) bits.push(`now fires only for the “${formLabel}” form`);
      if (reentry) bits.push(`re-enrollment set to ${reentry.replace("_", " ")}`);
      if (steps) bits.push(`${steps.length} step${steps.length === 1 ? "" : "s"} set`);
      return {
        resultText: `Updated “${name || wf.name}”: ${bits.join(", ")}. It's still ${wf.status} — publish it (set_workflow_status active) when you're happy, and you can test it on yourself first (test_workflow).`,
        ref: { kind: "workflow", id: wf.id },
      };
    },
  },
  {
    name: "test_workflow",
    level: "sub-account",
    requiredRole: "subAccountMember",
    menuLabel: "Run a workflow once for a chosen contact as a test (sends real messages)",
    description:
      "Enrol ONE contact in a workflow right now as a test — it ignores the trigger and filters, works on a draft, and SENDS REAL SMS/email/WhatsApp to that contact. Recommend the user's own contact record (find_contacts by their name or email) so nobody else gets test messages. Resolve both ids first — never guess. The result appears under the workflow's Runs tab.",
    parameters: {
      type: "object",
      properties: {
        workflowId: { type: "string", description: "The workflow's id from list_workflows." },
        workflowName: { type: "string", description: "The workflow's name, for the card." },
        contactId: { type: "string", description: "The contact to enrol, exactly as returned by find_contacts." },
        contactName: { type: "string", description: "The contact's name, for the card." },
      },
      required: ["workflowId", "workflowName", "contactId", "contactName"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const workflowId = str(raw, "workflowId");
      const contactId = str(raw, "contactId");
      if (!workflowId || !contactId) {
        return { ok: false, error: "both the workflow id and the contact id are required — look them up first" };
      }
      return {
        ok: true,
        args: { workflowId, workflowName: str(raw, "workflowName"), contactId, contactName: str(raw, "contactName") },
      };
    },
    summarize: (args) =>
      `Run the workflow “${args.workflowName || args.workflowId}” once for ${args.contactName || args.contactId} as a test — this sends REAL messages to that contact.`,
    execute: async (ctx, args) => {
      const contactId = args.contactId as string;
      const c = await getAdminDb().doc(`contacts/${contactId}`).get();
      if (!c.exists || c.data()?.subAccountId !== ctx.subAccountId) {
        throw new CapabilityUserError("That contact wasn't found in this workspace.");
      }
      const res = await enrollForTest({
        subAccountId: ctx.subAccountId!,
        workflowId: args.workflowId as string,
        contactId,
      });
      if (!res.ok) throw new CapabilityUserError(res.error ?? "The test couldn't start.");
      return {
        resultText: `Test run started for ${args.contactName || contactId}. Instant steps send within seconds; check the Runs tab on the workflow (and the contact's timeline) to see each step.`,
        ref: { kind: "workflow", id: args.workflowId as string },
      };
    },
  },
  {
    name: "update_website_cta",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    menuLabel: "Point a built website's call-to-action at a form or booking page (rebuilds the site)",
    description:
      "Set a website's call-to-action link (the button/link the site's CTA sections use) to a URL — typically the public URL of a form (from list_forms) or the workspace's booking page — and rebuild the site so it goes live. This is how the website feeds leads into the CRM. It queues a rebuild (usually 10–20 minutes) and counts toward the builds-per-hour limit. Resolve the site id with check_website_status first; use a URL you retrieved from a lookup, never one you guessed.",
    parameters: {
      type: "object",
      properties: {
        siteId: { type: "string", description: "The website's id from check_website_status." },
        siteName: { type: "string", description: "The site's name, for the card." },
        ctaLink: { type: "string", description: "Full http(s) URL the call-to-action should open." },
      },
      required: ["siteId", "siteName", "ctaLink"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const siteId = str(raw, "siteId");
      const ctaLink = str(raw, "ctaLink");
      if (!siteId) return { ok: false, error: "the website id is required — check_website_status first" };
      if (!/^https?:\/\/\S+$/i.test(ctaLink)) {
        return { ok: false, error: "ctaLink must be a full http(s) URL" };
      }
      return { ok: true, args: { siteId, siteName: str(raw, "siteName"), ctaLink } };
    },
    summarize: (args) =>
      `Point the website “${args.siteName || args.siteId}” call-to-action at ${args.ctaLink} and rebuild it.`,
    execute: async (ctx, args) => {
      try {
        const res = await updateWebsiteCtaAndRebuild({
          subAccountId: ctx.subAccountId!,
          siteId: args.siteId as string,
          ctaLink: args.ctaLink as string,
          buildByUid: ctx.uid,
        });
        return {
          resultText: `Rebuild queued for “${res.siteName}” with the call-to-action now pointing at ${args.ctaLink}${res.previousCtaLink ? ` (was ${res.previousCtaLink})` : ""}. Builds usually take 10–20 minutes — ask me to check the website status later.`,
          ref: { kind: "website", id: args.siteId as string },
        };
      } catch (err) {
        if (err instanceof WebsiteServiceError) throw new CapabilityUserError(err.message);
        throw err;
      }
    },
  },
];

/**
 * Agency-level "act in a named sub-account" wrapper around a workspace
 * capability, with no duplicated business logic. The owner is implicit admin
 * in every sub-account. It:
 *   1. adds required subAccountId + subAccountName params (from
 *      list_sub_accounts; the model is told never to guess ids),
 *   2. re-anchors the id to the caller's agency before anything runs,
 *   3. delegates to the base validate/summarize/execute with the verified
 *      subAccountId, so every guardrail inside the base capability still
 *      applies to the target workspace.
 */
function inSubAccount(base: AiSuiteCapability): AiSuiteCapability {
  const baseParams = base.parameters as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  return {
    name: `${base.name}_in_sub_account`,
    level: "agency",
    requiredRole: "agencyOwner",
    readonly: base.readonly,
    secretInputs: base.secretInputs,
    menuLabel: `${base.menuLabel} — in a sub-account you name`,
    description: `${base.description} AGENCY VARIANT: performs this inside one of your sub-accounts. Resolve the sub-account's id with list_sub_accounts first — never guess ids. Exception: if the user identifies the sub-account by its account number (e.g. '#1011') or you already know its exact name, you may pass that as subAccountId — it's resolved server-side within this agency. If what the user said could match more than one sub-account (e.g. 'rode' when both 'Rode Plumbing' and 'Rode Sound' exist), ask which one BEFORE proposing.`,
    parameters: {
      type: "object",
      properties: {
        subAccountId: {
          type: "string",
          description:
            "The target sub-account's id, exactly as returned by list_sub_accounts.",
        },
        subAccountName: {
          type: "string",
          description:
            "The target sub-account's display name, for the confirmation card.",
        },
        ...(baseParams.properties ?? {}),
      },
      required: [
        "subAccountId",
        "subAccountName",
        ...(baseParams.required ?? []),
      ],
      additionalProperties: false,
    },
    validate: (raw) => {
      const subAccountId = str(raw, "subAccountId");
      if (!subAccountId) {
        return {
          ok: false,
          error:
            "the target sub-account id is required — I need to look it up first (list_sub_accounts)",
        };
      }
      // A "/" would turn the doc lookup below into a nested path.
      if (subAccountId.includes("/")) {
        return {
          ok: false,
          error: "that isn't a valid sub-account id — look it up with list_sub_accounts",
        };
      }
      const inner = base.validate(raw);
      if (!inner.ok) return inner;
      return {
        ok: true,
        args: {
          ...inner.args,
          subAccountId,
          subAccountName: str(raw, "subAccountName"),
        },
      };
    },
    summarize: (args) =>
      `${base.summarize(args).replace(/\.\s*$/, "")} — in “${
        args.subAccountName || args.subAccountId
      }”.`,
    execute: async (ctx, args) => {
      const db = getAdminDb();
      let targetId: string | null = null;
      const snap = await db
        .doc(`subAccounts/${args.subAccountId as string}`)
        .get();
      if (snap.exists && snap.data()?.agencyId === ctx.agencyId) {
        // The confirm card shows subAccountName; refuse if it names a
        // different workspace than the id, so the owner approves what runs.
        // Punctuation-insensitive ("Rode's" vs "Rodes"); contains needs 3+ chars.
        const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9#]+/g, "");
        const rawShown =
          typeof args.subAccountName === "string" ? args.subAccountName.trim() : "";
        const shown = norm(rawShown);
        const actualName = norm(String(snap.data()?.name ?? ""));
        const actualNumber = snap.data()?.accountNumber;
        const nameMatches =
          !shown ||
          rawShown.toLowerCase() === snap.id.toLowerCase() ||
          (actualName.length > 0 &&
            (actualName === shown ||
              (shown.length >= 3 && actualName.includes(shown)) ||
              (actualName.length >= 3 && shown.includes(actualName)))) ||
          (typeof actualNumber === "number" && shown.replace(/#/g, "") === String(actualNumber));
        if (!nameMatches) {
          throw new CapabilityUserError(
            `That id belongs to “${snap.data()?.name ?? snap.id}”, not “${args.subAccountName as string}”. Check which sub-account you mean (list_sub_accounts) and ask again.`
          );
        }
        targetId = snap.id;
      } else {
        // Tool results don't survive across chat turns, so the model sometimes
        // passes the display name or "#1011" account number as the id.
        // Re-resolve strictly within the caller's agency (can only fix a bad
        // id, never widen scope). Exact name/number wins, then a unique
        // substring match; anything ambiguous refuses and lists candidates.
        const needles = [args.subAccountName, args.subAccountId]
          .map((v) => (typeof v === "string" ? v.trim().toLowerCase() : ""))
          .filter(Boolean);
        const numberNeedles = needles
          .map((n) => (/^#?\d+$/.test(n) ? Number(n.replace("#", "")) : null))
          .filter((n): n is number => n !== null);
        const agencySubs = await db
          .collection("subAccounts")
          .where("agencyId", "==", ctx.agencyId)
          .get();
        const rows = agencySubs.docs.map((d) => {
          const data = d.data();
          return {
            id: d.id,
            name: typeof data?.name === "string" ? data.name.trim() : "",
            accountNumber:
              typeof data?.accountNumber === "number"
                ? data.accountNumber
                : null,
          };
        });
        const label = (r: (typeof rows)[number]) =>
          r.accountNumber != null
            ? `“${r.name || "(unnamed)"}” (#${r.accountNumber})`
            : `“${r.name || r.id}”`;

        const exact = rows.filter(
          (r) =>
            (r.name && needles.includes(r.name.toLowerCase())) ||
            (r.accountNumber != null && numberNeedles.includes(r.accountNumber))
        );
        // Substring pass only when nothing matched exactly; needles under 3 chars over-match.
        const matches =
          exact.length > 0
            ? exact
            : rows.filter((r) => {
                const name = r.name.toLowerCase();
                return (
                  name.length > 0 &&
                  needles.some((n) => n.length >= 3 && name.includes(n))
                );
              });
        if (matches.length === 1) {
          targetId = matches[0]!.id;
        } else if (matches.length > 1) {
          throw new CapabilityUserError(
            `That matches more than one sub-account — did you mean ${matches
              .slice(0, 6)
              .map(label)
              .join(" or ")}${
              matches.length > 6 ? " (and more)" : ""
            }? Ask again with the exact name or the account number (e.g. #1011).`
          );
        }
      }
      if (!targetId) {
        throw new CapabilityUserError(
          "That sub-account wasn't found in this agency — check the name (or account number like #1011) under Agency → Sub-accounts and ask again."
        );
      }
      return base.execute(
        {
          ...ctx,
          subAccountId: targetId,
          subAccountRole: "agencyOwner",
          delegatedFromAgency: true,
        },
        args
      );
    },
  };
}

// Workspace capabilities the Agency Assistant may run in a named sub-account.
// A curated allowlist on purpose.
const AGENCY_DELEGATED = [
  "find_contacts",
  "find_deals",
  "find_tasks",
  "find_events",
  "workspace_stats",
  "list_webhooks",
  "list_members",
  "create_contact",
  "update_contact",
  "create_task",
  "complete_task",
  "create_deal",
  "move_deal_stage",
  "create_event",
  "create_workflow",
  "list_workflows",
  "set_workflow_status",
  "pause_all_workflows",
  "list_pipelines",
  "create_pipeline",
  "find_quotes",
  "mark_quote_paid",
  "find_awaiting_payment_bookings",
  "mark_booking_paid",
  "list_communities",
  "add_course",
  "add_lesson",
  "watchdog_status",
  "configure_watchdog",
  "stale_deals_status",
  "configure_stale_deals_monitor",
  "slack_status",
  "configure_slack_events",
  "connect_slack",
  "create_webhook",
  "send_webhook_test",
  "update_webhook_url",
  "create_community",
  "invite_member",
  // Website builder for a named client workspace. websiteEnabledByAgency still
  // applies inside the service.
  "get_website_prefill",
  "research_website_reference",
  "create_website",
  "list_website_concepts",
  "check_website_status",
  // Speed-to-Lead guided setup in a named client workspace.
  "speed_to_lead_readiness",
  "list_forms",
  "create_form",
  "configure_workflow",
  "test_workflow",
  "update_website_cta",
  // AI live booking setup in a named client workspace.
  "create_booking_page",
  "ai_booking_readiness",
  "configure_ai_booking",
];
for (const name of AGENCY_DELEGATED) {
  const base = AI_SUITE_CAPABILITIES.find((c) => c.name === name);
  if (base) AI_SUITE_CAPABILITIES.push(inSubAccount(base));
}

export function getCapability(name: string): AiSuiteCapability | undefined {
  return AI_SUITE_CAPABILITIES.find((c) => c.name === name);
}

/** Whether `role` satisfies the capability's required role. */
export function roleSatisfies(
  required: RequiredRole,
  ctx: { agencyRoleIsOwner: boolean; subAccountRole?: string }
): boolean {
  switch (required) {
    case "agencyOwner":
      return ctx.agencyRoleIsOwner;
    case "subAccountAdmin":
      return (
        ctx.subAccountRole === "admin" || ctx.subAccountRole === "agencyOwner"
      );
    case "subAccountMember":
      return !!ctx.subAccountRole; // any active member (already authed)
  }
}

/**
 * Tool definitions for a level, filtered by role so the model is only offered
 * tools the caller can run (it tells a collaborator to ask an admin instead of
 * proposing a doomed action).
 */
export function toolsForLevel(
  level: AiSuiteLevel,
  role: { agencyRoleIsOwner: boolean; subAccountRole?: string }
): Array<{ type: "function"; function: Record<string, unknown> }> {
  return AI_SUITE_CAPABILITIES.filter(
    (c) => c.level === level && roleSatisfies(c.requiredRole, role)
  ).map((c) => ({
    type: "function",
    function: {
      name: c.name,
      description: c.description,
      parameters: c.parameters,
    },
  }));
}

export interface CapabilityMenuItem {
  name: string;
  menuLabel: string;
}

/**
 * Names and menu labels for a level+role, split into lookups (run instantly)
 * and actions (need confirmation), for the prompt and "what can you do?".
 */
export function capabilityNamesForLevel(
  level: AiSuiteLevel,
  role: { agencyRoleIsOwner: boolean; subAccountRole?: string }
): { actions: CapabilityMenuItem[]; lookups: CapabilityMenuItem[] } {
  const offered = AI_SUITE_CAPABILITIES.filter(
    (c) => c.level === level && roleSatisfies(c.requiredRole, role)
  );
  const item = (c: AiSuiteCapability): CapabilityMenuItem => ({
    name: c.name,
    menuLabel: c.menuLabel,
  });
  return {
    actions: offered.filter((c) => !c.readonly).map(item),
    lookups: offered.filter((c) => c.readonly).map(item),
  };
}
