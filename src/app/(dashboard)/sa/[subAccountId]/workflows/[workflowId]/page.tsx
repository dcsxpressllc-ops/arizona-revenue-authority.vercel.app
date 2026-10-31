import { WorkflowBuilderLoader } from "@/components/workflows/workflow-builder-loader";
import type { BuilderReadiness } from "@/components/workflows/workflow-builder";
import { getAdminDb } from "@/lib/firebase/admin";
import { agencyAllowsSharedSms } from "@/lib/agency/policy";
import { emailIsConfigured, tenantFrom } from "@/lib/comms/resend";
import {
  smsIsConfigured,
  subAccountTwilioIsConfigured,
  subAccountWhatsappIsConfigured,
} from "@/lib/comms/twilio";
import {
  aiOutboundSmsGateOn,
  aiOutboundSmsReadiness,
  firstUnmet,
} from "@/lib/comms/ai/outbound-sms";
import type { SubAccountDoc } from "@/types";

export const dynamic = "force-dynamic";

export default async function WorkflowBuilderPage({
  params,
}: {
  params: Promise<{ subAccountId: string; workflowId: string }>;
}) {
  const { subAccountId, workflowId } = await params;

  // Resolve server-side which send integrations can actually run (env vars,
  // the sub-account's twilioConfig, WhatsApp template inventory) so a doomed
  // step is flagged deterministically. Mirrors the engine's send-time checks
  // (engine.ts execSendSms / execWhatsappTemplate).
  const db = getAdminDb();
  const [snap, approvedWhatsapp] = await Promise.all([
    db.doc(`subAccounts/${subAccountId}`).get(),
    // With no Meta-approved template every whatsapp_template node is skipped,
    // so the channel counts as not ready even with gate + sender configured.
    db
      .collection(`subAccounts/${subAccountId}/whatsappTemplates`)
      .where("status", "==", "approved")
      .limit(1)
      .get(),
  ]);
  const sub = snap.data() as SubAccountDoc | undefined;
  const tc = sub?.twilioConfig ?? null;

  // Tiers evaluated separately so the node can show a per-tier breakdown. The
  // shared "agency" SMS tier needs env creds AND agency permission to use it.
  const smsSub = subAccountTwilioIsConfigured(tc);
  const smsAgency = smsIsConfigured() && (await agencyAllowsSharedSms(sub?.agencyId));
  const emailSub = tenantFrom(sub) !== undefined;
  const emailAgency = emailIsConfigured();
  const whatsappGate = sub?.whatsappEnabledByAgency === true;
  const whatsappSender = subAccountWhatsappIsConfigured(tc);
  const whatsappTemplate = !approvedWhatsapp.empty;
  // Same checks the engine runs before every AI text.
  const aiSmsGate = aiOutboundSmsGateOn(sub);
  const aiSmsUnmet =
    sub && aiSmsGate
      ? firstUnmet(await aiOutboundSmsReadiness(subAccountId, sub))
      : null;
  const aiSmsMissing = !aiSmsGate
    ? "Your agency hasn't enabled AI texts for this workspace."
    : aiSmsUnmet
      ? `Missing: ${aiSmsUnmet.label}. ${aiSmsUnmet.fix}`
      : null;

  const readiness: BuilderReadiness = {
    emailReady: emailAgency,
    smsReady: smsSub || smsAgency,
    whatsappReady: whatsappGate && whatsappSender && whatsappTemplate,
    aiSmsReady: aiSmsMissing === null,
    detail: {
      smsSub,
      smsAgency,
      emailSub,
      emailAgency,
      whatsappGate,
      whatsappSender,
      whatsappTemplate,
      aiSmsGate,
      aiSmsMissing,
    },
  };

  return (
    <div className="mx-auto w-full max-w-5xl">
      <WorkflowBuilderLoader
        saId={subAccountId}
        workflowId={workflowId}
        readiness={readiness}
      />
    </div>
  );
}
