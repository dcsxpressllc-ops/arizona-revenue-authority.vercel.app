import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { metaAppConfigured } from "@/lib/comms/meta";
import { emailIsConfigured } from "@/lib/comms/resend";
import {
  aiOutboundSmsReadiness,
  firstUnmet,
} from "@/lib/comms/ai/outbound-sms";
import type { SubAccountDoc } from "@/types";
import {
  sanitizeUsageQuotas,
  gatesOnNow,
  invalidateUsageBillingCache,
  stampFeaturesOn,
  validateFeatureFees,
  validateSpendCap,
  validateUsageRates,
} from "@/lib/server/usage-meter";
import {
  applyFeatureGates,
  type AgencyGateField,
} from "@/lib/server/feature-gates-service";

/**
 * Agency-owner-only feature gates for a sub-account; only the fields sent are
 * applied. Disabling the email domain tears down the Resend domain and clears
 * resendConfig (sends fall back to EMAIL_FROM). Disabling API access 403s
 * /api/v1/* but keeps keys and webhook subscriptions so re-enabling resumes them.
 * Sub-account admins can't flip their own gates.
 */

interface PatchBody {
  emailDomainEnabled?: boolean;
  apiAccessEnabled?: boolean;
  broadcastsEnabled?: boolean;
  outboundVoiceEnabled?: boolean;
  whatsappEnabled?: boolean;
  smsAgentEnabled?: boolean;
  webChatEnabled?: boolean;
  inboundVoiceEnabled?: boolean;
  metaInboxEnabled?: boolean;
  metaAgentEnabled?: boolean;
  websiteEnabled?: boolean;
  socialPlannerEnabled?: boolean;
  communityEnabled?: boolean;
  missedCallTextBackEnabled?: boolean;
  aiSuiteEnabled?: boolean;
  /** Workspace Assistant model tier. A preference, not a gate; unset reads as opus. */
  aiSuiteModel?: "opus" | "sonnet";
  labsEnabled?: boolean;
  agentsEnabled?: boolean;
  getLeadsEnabled?: boolean;
  paymentsEnabled?: boolean;
  webinar1Enabled?: boolean;
  webVoiceEnabled?: boolean;
  sellOnlineEnabled?: boolean;
  aiOutboundSmsEnabled?: boolean;
  /** Per-workspace quota override. `null` clears back to plan/unlimited. */
  usageQuotas?: import("@/types/usage").UsageQuotas | null;
  /** Per-workspace overage-rate override, same contract as quotas. */
  usageRates?: import("@/types/usage").UsageRates | null;
  /** Bill this client for usage and flat fees (needs the agency switch on). */
  usageRebillingEnabled?: boolean;
  /** Spend ceiling override in cents; 0 = none for this client, null = plan's. */
  usageSpendCapCents?: number | null;
  /** Flat-fee override; null = plan's, {} = no fees. */
  featureFees?: import("@/types/usage").FeatureFees | null;
  // "Hide instead of lock" sidebar overrides; only apply while the gate is off.
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
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;
  if (access.subAccountRole !== "agencyOwner") {
    return NextResponse.json({ error: "Agency owner only" }, { status: 403 });
  }

  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const wantsEmail = typeof body.emailDomainEnabled === "boolean";
  const wantsApi = typeof body.apiAccessEnabled === "boolean";
  const wantsBroadcasts = typeof body.broadcastsEnabled === "boolean";
  const wantsOutboundVoice = typeof body.outboundVoiceEnabled === "boolean";
  const wantsWhatsapp = typeof body.whatsappEnabled === "boolean";
  const wantsSmsAgent = typeof body.smsAgentEnabled === "boolean";
  const wantsWebChat = typeof body.webChatEnabled === "boolean";
  const wantsInboundVoice = typeof body.inboundVoiceEnabled === "boolean";
  const wantsMetaInbox = typeof body.metaInboxEnabled === "boolean";
  const wantsMetaAgent = typeof body.metaAgentEnabled === "boolean";
  const wantsWebsite = typeof body.websiteEnabled === "boolean";
  const wantsSocialPlanner = typeof body.socialPlannerEnabled === "boolean";
  const wantsCommunity = typeof body.communityEnabled === "boolean";
  const wantsMissedCall = typeof body.missedCallTextBackEnabled === "boolean";
  const wantsAiSuite = typeof body.aiSuiteEnabled === "boolean";
  const wantsAiSuiteModel = body.aiSuiteModel !== undefined;
  if (
    wantsAiSuiteModel &&
    body.aiSuiteModel !== "opus" &&
    body.aiSuiteModel !== "sonnet"
  ) {
    return NextResponse.json(
      { error: "aiSuiteModel must be 'opus' or 'sonnet'." },
      { status: 400 }
    );
  }
  const wantsLabs = typeof body.labsEnabled === "boolean";
  const wantsAgents = typeof body.agentsEnabled === "boolean";
  const wantsGetLeads = typeof body.getLeadsEnabled === "boolean";
  const wantsPayments = typeof body.paymentsEnabled === "boolean";
  const wantsWebinar1 = typeof body.webinar1Enabled === "boolean";
  const wantsWebVoice = typeof body.webVoiceEnabled === "boolean";
  const wantsSellOnline = typeof body.sellOnlineEnabled === "boolean";
  const wantsAiOutboundSms = typeof body.aiOutboundSmsEnabled === "boolean";
  const wantsBroadcastsHidden =
    typeof body.broadcastsHiddenWhenDisabled === "boolean";
  const wantsWebsiteHidden =
    typeof body.websiteHiddenWhenDisabled === "boolean";
  const wantsSocialPlannerHidden =
    typeof body.socialPlannerHiddenWhenDisabled === "boolean";
  const wantsCommunityHidden =
    typeof body.communityHiddenWhenDisabled === "boolean";
  const wantsGetLeadsHidden =
    typeof body.getLeadsHiddenWhenDisabled === "boolean";
  const wantsAiSuiteHidden =
    typeof body.aiSuiteHiddenWhenDisabled === "boolean";
  const wantsLabsHidden = typeof body.labsHiddenWhenDisabled === "boolean";
  const wantsAgentsHidden =
    typeof body.agentsHiddenWhenDisabled === "boolean";
  const wantsPaymentsHidden =
    typeof body.paymentsHiddenWhenDisabled === "boolean";
  const wantsWebinar1Hidden =
    typeof body.webinar1HiddenWhenDisabled === "boolean";
  const wantsUsageQuotas = body.usageQuotas !== undefined;
  const wantsUsageRates = body.usageRates !== undefined;
  const wantsRebilling = typeof body.usageRebillingEnabled === "boolean";
  const wantsSpendCap = body.usageSpendCapCents !== undefined;
  const wantsFeatureFees = body.featureFees !== undefined;
  if (
    !wantsUsageQuotas &&
    !wantsUsageRates &&
    !wantsRebilling &&
    !wantsSpendCap &&
    !wantsFeatureFees &&
    !wantsEmail &&
    !wantsApi &&
    !wantsBroadcasts &&
    !wantsOutboundVoice &&
    !wantsWhatsapp &&
    !wantsSmsAgent &&
    !wantsWebChat &&
    !wantsInboundVoice &&
    !wantsMetaInbox &&
    !wantsMetaAgent &&
    !wantsWebsite &&
    !wantsSocialPlanner &&
    !wantsCommunity &&
    !wantsMissedCall &&
    !wantsAiSuite &&
    !wantsAiSuiteModel &&
    !wantsLabs &&
    !wantsGetLeads &&
    !wantsPayments &&
    !wantsWebinar1 &&
    !wantsWebVoice &&
    !wantsSellOnline &&
    !wantsAiOutboundSms &&
    !wantsBroadcastsHidden &&
    !wantsWebsiteHidden &&
    !wantsSocialPlannerHidden &&
    !wantsCommunityHidden &&
    !wantsGetLeadsHidden &&
    !wantsAiSuiteHidden &&
    !wantsLabsHidden &&
    !wantsPaymentsHidden &&
    !wantsWebinar1Hidden
  ) {
    return NextResponse.json(
      {
        error:
          "At least one of `emailDomainEnabled`, `apiAccessEnabled`, `broadcastsEnabled`, `outboundVoiceEnabled`, `whatsappEnabled`, `metaInboxEnabled`, `websiteEnabled`, `socialPlannerEnabled`, `broadcastsHiddenWhenDisabled`, `websiteHiddenWhenDisabled`, or `socialPlannerHiddenWhenDisabled` (boolean) is required.",
      },
      { status: 400 }
    );
  }

  // Meta gates can't be enabled without app creds on the deployment (the UI
  // grays them out, this guards the API). Disabling is always allowed.
  if (
    (body.metaInboxEnabled === true ||
      body.socialPlannerEnabled === true ||
      body.metaAgentEnabled === true) &&
    !metaAppConfigured()
  ) {
    return NextResponse.json(
      {
        error:
          "Facebook/Instagram isn't configured on this deployment. Set META_APP_ID and META_APP_SECRET to enable the inbox or Social Planner.",
      },
      { status: 400 }
    );
  }

  // Buyers must get a confirmation email, so no selling without email.
  if (body.sellOnlineEnabled === true && !emailIsConfigured()) {
    return NextResponse.json(
      {
        error:
          "Email isn't configured on this deployment. Set RESEND_API_KEY and EMAIL_FROM so buyers get their order confirmation, then enable Sell online.",
      },
      { status: 400 }
    );
  }

  const db = getAdminDb();
  const subRef = db.doc(`subAccounts/${subAccountId}`);
  const subSnap = await subRef.get();
  if (!subSnap.exists) {
    return NextResponse.json(
      { error: "Sub-account not found" },
      { status: 404 }
    );
  }

  // Billing fields are validated before any write so a bad value can't leave a
  // half-applied update.
  const billingUpdates: Record<string, unknown> = {};
  const subData = subSnap.data() as SubAccountDoc;
  if (wantsUsageRates) {
    const v = validateUsageRates(body.usageRates, {
      dedicatedSms: subData.twilioConfig?.enabled === true,
    });
    if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
    // An object (even all blank) is a custom override; only null falls back to the plan.
    billingUpdates.usageRates = body.usageRates === null ? null : (v.rates ?? {});
  }
  if (wantsSpendCap) {
    const v = validateSpendCap(body.usageSpendCapCents, { allowZero: true });
    if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
    billingUpdates.usageSpendCapCents = v.cents;
  }
  if (wantsFeatureFees) {
    const v = validateFeatureFees(body.featureFees);
    if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
    billingUpdates.featureFees = v.fees;
  }
  if (wantsRebilling) {
    if (body.usageRebillingEnabled === true) {
      const agencySnap = await db.doc(`agencies/${subData.agencyId}`).get();
      if (agencySnap.data()?.usageRebillingEnabled !== true) {
        return NextResponse.json(
          {
            error:
              "Turn on Usage rebilling for the agency first (Agency → Client billing).",
          },
          { status: 400 }
        );
      }
    }
    billingUpdates.usageRebillingEnabled = body.usageRebillingEnabled;
    if (body.usageRebillingEnabled === true && subData.usageRebillingEnabled !== true) {
      billingUpdates.usageRebillingSince = FieldValue.serverTimestamp();
    }
  }

  // AI texts stay off until everything the reply path needs is in place.
  // Disabling is always allowed.
  if (body.aiOutboundSmsEnabled === true) {
    // Readiness reads the stored doc, so catch the SMS AI gate going off in this same request.
    if (body.smsAgentEnabled === false) {
      return NextResponse.json(
        {
          error:
            "AI texts need SMS AI auto-reply allowed, so they can't be enabled while it's being switched off.",
        },
        { status: 400 }
      );
    }
    const readiness = await aiOutboundSmsReadiness(
      subAccountId,
      subSnap.data() as SubAccountDoc
    );
    const unmet = firstUnmet(readiness);
    if (unmet) {
      return NextResponse.json(
        {
          error: `AI texts can't be enabled yet: ${unmet.label.toLowerCase()} is missing. ${unmet.fix}`,
          checks: readiness.checks,
        },
        { status: 400 }
      );
    }
  }

  // Gates go through feature-gates-service so side effects (email-domain
  // tear-down, Meta guard) stay identical to the plan-driven billing path.
  const gates: Partial<Record<AgencyGateField, boolean>> = {};
  if (typeof body.emailDomainEnabled === "boolean") {
    gates.emailDomainEnabledByAgency = body.emailDomainEnabled;
  }
  if (typeof body.apiAccessEnabled === "boolean") {
    gates.apiAccessEnabledByAgency = body.apiAccessEnabled;
  }
  if (typeof body.broadcastsEnabled === "boolean") {
    gates.broadcastsEnabledByAgency = body.broadcastsEnabled;
  }
  if (typeof body.outboundVoiceEnabled === "boolean") {
    gates.outboundVoiceEnabledByAgency = body.outboundVoiceEnabled;
  }
  if (typeof body.whatsappEnabled === "boolean") {
    gates.whatsappEnabledByAgency = body.whatsappEnabled;
  }
  if (typeof body.smsAgentEnabled === "boolean") {
    gates.smsAgentEnabledByAgency = body.smsAgentEnabled;
  }
  if (typeof body.webChatEnabled === "boolean") {
    gates.webChatEnabledByAgency = body.webChatEnabled;
  }
  if (typeof body.inboundVoiceEnabled === "boolean") {
    gates.inboundVoiceEnabledByAgency = body.inboundVoiceEnabled;
  }
  if (typeof body.metaInboxEnabled === "boolean") {
    gates.metaInboxEnabledByAgency = body.metaInboxEnabled;
  }
  if (typeof body.metaAgentEnabled === "boolean") {
    gates.metaAgentEnabledByAgency = body.metaAgentEnabled;
  }
  if (typeof body.websiteEnabled === "boolean") {
    gates.websiteEnabledByAgency = body.websiteEnabled;
  }
  if (typeof body.socialPlannerEnabled === "boolean") {
    gates.socialPlannerEnabledByAgency = body.socialPlannerEnabled;
  }
  if (typeof body.communityEnabled === "boolean") {
    gates.communityEnabledByAgency = body.communityEnabled;
  }
  if (typeof body.missedCallTextBackEnabled === "boolean") {
    gates.missedCallTextBackEnabledByAgency = body.missedCallTextBackEnabled;
  }
  if (typeof body.aiSuiteEnabled === "boolean") {
    gates.aiSuiteEnabledByAgency = body.aiSuiteEnabled;
  }
  if (typeof body.labsEnabled === "boolean") {
    gates.labsEnabledByAgency = body.labsEnabled;
  }
  if (typeof body.agentsEnabled === "boolean") {
    gates.agentsEnabledByAgency = body.agentsEnabled;
  }
  if (typeof body.getLeadsEnabled === "boolean") {
    gates.getLeadsEnabledByAgency = body.getLeadsEnabled;
  }
  if (typeof body.paymentsEnabled === "boolean") {
    gates.paymentsEnabledByAgency = body.paymentsEnabled;
  }
  if (typeof body.webinar1Enabled === "boolean") {
    gates.webinar1EnabledByAgency = body.webinar1Enabled;
  }
  if (typeof body.webVoiceEnabled === "boolean") {
    gates.webVoiceEnabledByAgency = body.webVoiceEnabled;
  }
  if (typeof body.sellOnlineEnabled === "boolean") {
    gates.sellOnlineEnabledByAgency = body.sellOnlineEnabled;
  }
  if (typeof body.aiOutboundSmsEnabled === "boolean") {
    gates.aiOutboundSmsEnabledByAgency = body.aiOutboundSmsEnabled;
  }

  let clearedDomain = false;
  if (Object.keys(gates).length > 0) {
    ({ clearedDomain } = await applyFeatureGates(subAccountId, gates));
  }

  // Non-gate fields (hide flags, model tier, usage overrides). Hide flags are
  // presentation only; routes 403 the same either way. Not plan-managed.
  const hiddenUpdates: Record<string, unknown> = {};
  if (wantsAiSuiteModel) {
    hiddenUpdates.aiSuiteModel = body.aiSuiteModel;
  }
  if (wantsBroadcastsHidden) {
    hiddenUpdates.broadcastsHiddenWhenDisabled =
      body.broadcastsHiddenWhenDisabled;
  }
  if (wantsWebsiteHidden) {
    hiddenUpdates.websiteHiddenWhenDisabled = body.websiteHiddenWhenDisabled;
  }
  if (wantsSocialPlannerHidden) {
    hiddenUpdates.socialPlannerHiddenWhenDisabled =
      body.socialPlannerHiddenWhenDisabled;
  }
  if (wantsCommunityHidden) {
    hiddenUpdates.communityHiddenWhenDisabled =
      body.communityHiddenWhenDisabled;
  }
  if (wantsGetLeadsHidden) {
    hiddenUpdates.getLeadsHiddenWhenDisabled = body.getLeadsHiddenWhenDisabled;
  }
  if (wantsAiSuiteHidden) {
    hiddenUpdates.aiSuiteHiddenWhenDisabled = body.aiSuiteHiddenWhenDisabled;
  }
  if (wantsLabsHidden) {
    hiddenUpdates.labsHiddenWhenDisabled = body.labsHiddenWhenDisabled;
  }
  if (wantsAgentsHidden) {
    hiddenUpdates.agentsHiddenWhenDisabled = body.agentsHiddenWhenDisabled;
  }
  if (wantsPaymentsHidden) {
    hiddenUpdates.paymentsHiddenWhenDisabled = body.paymentsHiddenWhenDisabled;
  }
  if (wantsWebinar1Hidden) {
    hiddenUpdates.webinar1HiddenWhenDisabled = body.webinar1HiddenWhenDisabled;
  }
  if (wantsUsageQuotas) {
    hiddenUpdates.usageQuotas =
      body.usageQuotas === null ? null : (sanitizeUsageQuotas(body.usageQuotas) ?? {});
  }
  Object.assign(hiddenUpdates, billingUpdates);
  if (Object.keys(hiddenUpdates).length > 0) {
    hiddenUpdates.updatedAt = FieldValue.serverTimestamp();
    await subRef.update(hiddenUpdates);
  }
  if (Object.keys(billingUpdates).length > 0 || wantsUsageQuotas) {
    invalidateUsageBillingCache();
  }
  // Turning on mid-month bills the whole month, fees included, so record the
  // gates that are on right now.
  if (body.usageRebillingEnabled === true && subData.usageRebillingEnabled !== true) {
    const fresh = (await subRef.get()).data() ?? {};
    await stampFeaturesOn(subAccountId, gatesOnNow(fresh));
  }

  return NextResponse.json({
    ok: true,
    ...(wantsEmail ? { emailDomainEnabled: body.emailDomainEnabled } : {}),
    ...(wantsApi ? { apiAccessEnabled: body.apiAccessEnabled } : {}),
    ...(wantsBroadcasts ? { broadcastsEnabled: body.broadcastsEnabled } : {}),
    ...(wantsOutboundVoice
      ? { outboundVoiceEnabled: body.outboundVoiceEnabled }
      : {}),
    ...(wantsWhatsapp ? { whatsappEnabled: body.whatsappEnabled } : {}),
    ...(wantsSmsAgent ? { smsAgentEnabled: body.smsAgentEnabled } : {}),
    ...(wantsWebChat ? { webChatEnabled: body.webChatEnabled } : {}),
    ...(wantsInboundVoice
      ? { inboundVoiceEnabled: body.inboundVoiceEnabled }
      : {}),
    ...(wantsMetaInbox ? { metaInboxEnabled: body.metaInboxEnabled } : {}),
    ...(wantsMetaAgent ? { metaAgentEnabled: body.metaAgentEnabled } : {}),
    ...(wantsWebsite ? { websiteEnabled: body.websiteEnabled } : {}),
    ...(wantsSocialPlanner
      ? { socialPlannerEnabled: body.socialPlannerEnabled }
      : {}),
    ...(wantsCommunity ? { communityEnabled: body.communityEnabled } : {}),
    ...(wantsMissedCall
      ? { missedCallTextBackEnabled: body.missedCallTextBackEnabled }
      : {}),
    ...(wantsAiSuite ? { aiSuiteEnabled: body.aiSuiteEnabled } : {}),
    ...(wantsAiSuiteModel ? { aiSuiteModel: body.aiSuiteModel } : {}),
    ...(wantsLabs ? { labsEnabled: body.labsEnabled } : {}),
    ...(wantsAgents ? { agentsEnabled: body.agentsEnabled } : {}),
    ...(wantsGetLeads ? { getLeadsEnabled: body.getLeadsEnabled } : {}),
    ...(wantsWebinar1 ? { webinar1Enabled: body.webinar1Enabled } : {}),
    ...(wantsWebVoice ? { webVoiceEnabled: body.webVoiceEnabled } : {}),
    ...(wantsSellOnline ? { sellOnlineEnabled: body.sellOnlineEnabled } : {}),
    ...(wantsAiOutboundSms
      ? { aiOutboundSmsEnabled: body.aiOutboundSmsEnabled }
      : {}),
    ...(wantsWebinar1Hidden
      ? { webinar1HiddenWhenDisabled: body.webinar1HiddenWhenDisabled }
      : {}),
    ...(wantsBroadcastsHidden
      ? { broadcastsHiddenWhenDisabled: body.broadcastsHiddenWhenDisabled }
      : {}),
    ...(wantsWebsiteHidden
      ? { websiteHiddenWhenDisabled: body.websiteHiddenWhenDisabled }
      : {}),
    ...(wantsSocialPlannerHidden
      ? {
          socialPlannerHiddenWhenDisabled: body.socialPlannerHiddenWhenDisabled,
        }
      : {}),
    ...(wantsCommunityHidden
      ? { communityHiddenWhenDisabled: body.communityHiddenWhenDisabled }
      : {}),
    ...(wantsGetLeadsHidden
      ? { getLeadsHiddenWhenDisabled: body.getLeadsHiddenWhenDisabled }
      : {}),
    ...(wantsAiSuiteHidden
      ? { aiSuiteHiddenWhenDisabled: body.aiSuiteHiddenWhenDisabled }
      : {}),
    ...(wantsLabsHidden
      ? { labsHiddenWhenDisabled: body.labsHiddenWhenDisabled }
      : {}),
    ...(wantsAgentsHidden
      ? { agentsHiddenWhenDisabled: body.agentsHiddenWhenDisabled }
      : {}),
    ...(clearedDomain ? { clearedDomain: true } : {}),
  });
}
