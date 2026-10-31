import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { removeSendingDomain } from "@/lib/comms/resend-domains";
import { metaAppConfigured } from "@/lib/comms/meta";
import type { ResendConfig } from "@/types";
import {
  FEE_GATE_KEYS,
  feeGateOn,
  type FeeGateKey,
  type PlanGateKey,
} from "@/types/billing";
import { stampFeaturesOn } from "@/lib/server/usage-meter";

/**
 * The one place that flips `*EnabledByAgency` fields, used by the manual PATCH
 * route (/api/agency/sub-accounts/[id]/feature-gates) and by billing when a plan
 * applies its gates, so per-gate side effects can't diverge.
 *
 *   - Disabling the email-domain gate tears down the Resend domain and clears
 *     resendConfig. tenantFrom() also short-circuits on the gate if cleanup fails.
 *   - Meta gates (inbox, Social Planner) can't be enabled without
 *     META_APP_ID/SECRET. The manual route returns 400; a plan writes false and
 *     reports the key in skippedMetaGates so activation never hard-fails.
 *   - Everything else is a plain boolean write.
 */

/**
 * Gates the agency can flip. PlanGateKey is what a plan can bundle; the extras
 * stay out of plans on purpose: Get Leads is parked, and a plan silently
 * switching a money rail is worse than a manual toggle.
 */
export type AgencyGateField =
  | PlanGateKey
  | "getLeadsEnabledByAgency"
  | "paymentsEnabledByAgency"
  // Standalone like Payments: an outside integration is a per-client decision.
  | "webinar1EnabledByAgency"
  // Standalone for the same reason (client's own ElevenLabs key).
  | "webVoiceEnabledByAgency"
  // Standalone: selling online rides the Payments money rail.
  | "sellOnlineEnabledByAgency"
  // Standalone: enabling needs the workspace's own Twilio + SMS agent, which a
  // plan can't guarantee (see aiOutboundSmsReadiness).
  | "aiOutboundSmsEnabledByAgency";

export interface ApplyGatesResult {
  /** A live Resend domain was removed by the email disable. */
  clearedDomain: boolean;
  /** Meta gates the plan wanted on but the deployment can't enable. */
  skippedMetaGates: PlanGateKey[];
}

const META_GATES: ReadonlySet<AgencyGateField> = new Set([
  "metaInboxEnabledByAgency",
  "socialPlannerEnabledByAgency",
  // The AI auto-reply needs the same Meta app creds as the inbox.
  "metaAgentEnabledByAgency",
]);

export async function applyFeatureGates(
  subAccountId: string,
  gates: Partial<Record<AgencyGateField, boolean>>
): Promise<ApplyGatesResult> {
  const db = getAdminDb();
  const subRef = db.doc(`subAccounts/${subAccountId}`);
  const subSnap = await subRef.get();
  if (!subSnap.exists) {
    throw new Error(`Sub-account ${subAccountId} not found`);
  }
  const existingCfg = subSnap.data()?.resendConfig as
    | ResendConfig
    | null
    | undefined;

  const updates: Record<string, unknown> = {
    updatedAt: FieldValue.serverTimestamp(),
  };
  const result: ApplyGatesResult = {
    clearedDomain: false,
    skippedMetaGates: [],
  };

  const metaConfigured = metaAppConfigured();

  for (const [key, wanted] of Object.entries(gates) as Array<
    [AgencyGateField, boolean | undefined]
  >) {
    if (typeof wanted !== "boolean") continue;

    if (key === "emailDomainEnabledByAgency" && !wanted) {
      // So the agency stops paying for a Resend slot the sub-account can't use.
      if (existingCfg?.domainId) {
        await removeSendingDomain(existingCfg.domainId);
        result.clearedDomain = true;
      }
      updates.emailDomainEnabledByAgency = false;
      updates.resendConfig = null;
      continue;
    }

    if (wanted && META_GATES.has(key) && !metaConfigured) {
      updates[key] = false;
      result.skippedMetaGates.push(key as PlanGateKey);
      continue;
    }

    updates[key] = wanted;
  }

  await subRef.update(updates);

  // Flat fees bill for any month a gate was on, so record both a gate going on
  // and one that was on until now going off.
  const before = subSnap.data() ?? {};
  const touched = (Object.keys(gates) as AgencyGateField[]).filter(
    (k): k is FeeGateKey =>
      (FEE_GATE_KEYS as readonly string[]).includes(k) &&
      (updates[k] === true || feeGateOn(before, k as FeeGateKey)),
  );
  await stampFeaturesOn(subAccountId, touched);
  return result;
}
