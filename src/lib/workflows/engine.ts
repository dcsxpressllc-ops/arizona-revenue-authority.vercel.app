import "server-only";

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { sendEmail, emailIsConfigured, tenantFrom } from "@/lib/comms/resend";
import { resolveThreadedReplyTo } from "@/lib/comms/email-inbox";
import { smsSendBlock } from "@/lib/comms/sms-consent";
import {
  sendSmsForSubAccount,
  sendWhatsappTemplateForSubAccount,
  smsIsConfigured,
  subAccountTwilioIsConfigured,
  subAccountWhatsappIsConfigured,
  SmsRecipientUnsubscribedError,
} from "@/lib/comms/twilio";
import { agencyAllowsSharedSms } from "@/lib/agency/policy";
import { resolveTemplateVariables } from "@/lib/comms/whatsapp/resolve-template-variables";
import { createTaskServerSide } from "@/lib/server/tasks-service";
import { runAfterResponse } from "@/lib/server/after-response";
import { checkQuota, checkQuotas, UsageQuotaExceededError } from "@/lib/server/usage-meter";
import {
  resolveMergeTags,
  type MergeTagSubject,
} from "@/lib/automations/merge-tags";
import { buildUnsubscribeUrl } from "@/lib/automations/unsubscribe-token";
import { publishCallback, qstashIsConfigured } from "@/lib/automations/qstash";
import {
  aiOutboundSmsGateOn,
  aiOutboundSmsReadiness,
  firstUnmet,
  generateAiOpener,
} from "@/lib/comms/ai/outbound-sms";
import { incrementChannelTokens } from "@/lib/comms/ai/agent";
import { secondsUntilAiCanConverse } from "@/lib/comms/business-hours";
import { evalConditionGroup } from "./conditions";
import type { Contact } from "@/types/contacts";
import type { AgencyDoc, SubAccountDoc } from "@/types";
import type { WhatsappTemplateDoc } from "@/types/whatsapp-templates";
import type {
  CreateTaskConfig,
  IfElseConfig,
  MoveStageConfig,
  NotifyConfig,
  SendEmailConfig,
  SendAiSmsConfig,
  SendSmsConfig,
  TagConfig,
  WhatsappTemplateConfig,
  UpdateFieldConfig,
  WaitConfig,
  WaitForReplyConfig,
  WebhookConfig,
  WorkflowDoc,
  WorkflowNode,
  WorkflowNodeType,
  WorkflowRunDoc,
  WorkflowRunHistoryEntry,
  WorkflowTriggerType,
} from "@/types/workflows";

const STEP_PATH = "/api/workflows/step";

/** A deferring step gives up after this many waits (about three days of closed hours). */
const MAX_NODE_RETRIES = 3;

const NODE_LABEL_FOR_LOG: Partial<Record<WorkflowNodeType, string>> = {
  send_ai_sms: "Send AI text",
};

// Node executors

export type StepResult =
  | { kind: "next" }
  | { kind: "wait"; seconds: number }
  | { kind: "branch"; value: boolean }
  | { kind: "end" }
  /** Run this same node again after a delay; nothing is recorded as done. */
  | { kind: "retry"; seconds: number };

interface NodeContext {
  node: WorkflowNode;
  contact: Contact;
  subAccount: SubAccountDoc | null;
  owner: { displayName: string; email: string };
  subAccountId: string;
  agencyId: string;
  /** Workflow author, stamped on task writes for audit. */
  createdByUid: string;
  /** Captured at enrollment (e.g. form answers under `formData`); the Webhook
   *  step forwards it. */
  triggerContext: Record<string, unknown>;
}

/** Returns the control-flow result plus a short audit log string. */
type NodeExecutor = (
  ctx: NodeContext
) => Promise<{ result: StepResult; log: string }>;

function mergeSubject(
  ctx: NodeContext,
  unsubscribeLink: string
): MergeTagSubject {
  return {
    contact: {
      name: ctx.contact.name,
      email: ctx.contact.email,
      phone: ctx.contact.phone,
    },
    owner: ctx.owner,
    workspace: { name: ctx.subAccount?.name ?? "" },
    bookingLink: ctx.subAccount?.bookingLink ?? "",
    unsubscribeLink,
  };
}

const execSendEmail: NodeExecutor = async (ctx) => {
  const cfg = ctx.node.config as unknown as SendEmailConfig;
  const contact = ctx.contact;
  if (contact.emailOptedOut)
    return { result: { kind: "next" }, log: "skipped:opt_out" };
  const to = contact.email;
  if (!to) return { result: { kind: "next" }, log: "skipped:no_email" };
  if (!emailIsConfigured()) {
    return { result: { kind: "next" }, log: "error:email_not_configured" };
  }

  // Monthly email quota. Fails open.
  const emailQuota = await checkQuota({
    subAccountId: ctx.subAccountId,
    unit: "emailsSent",
    subAccount: ctx.subAccount,
  });
  if (!emailQuota.allowed) {
    return { result: { kind: "next" }, log: "skipped:quota" };
  }

  const unsubscribeLink = buildUnsubscribeUrl(contact.id);
  const subject = resolveMergeTags(
    cfg.subject ?? "",
    mergeSubject(ctx, unsubscribeLink)
  );
  const text = resolveMergeTags(
    cfg.body ?? "",
    mergeSubject(ctx, unsubscribeLink)
  );
  const htmlInner = resolveMergeTags(
    cfg.body ?? "",
    mergeSubject(ctx, `<a href="${unsubscribeLink}">Unsubscribe</a>`)
  ).replace(/\r?\n/g, "<br>");
  const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,sans-serif;line-height:1.6;color:#1a1a1a;max-width:600px;margin:0 auto;padding:24px;">${htmlInner}</body></html>`;

  try {
    const { id: messageId } = await sendEmail({
      to,
      subject: subject || "(no subject)",
      text,
      html,
      // With the email inbox on, replies come back into the unified inbox (and can
      // resolve wait_for_reply).
      replyTo: resolveThreadedReplyTo(
        ctx.subAccount,
        contact.id,
        ctx.subAccount?.replyToEmail ?? undefined,
      ),
      from: tenantFrom(ctx.subAccount),
      meter: { subAccountId: ctx.subAccountId },
    });
    // Log on the contact too: an automation that emails a customer has to be
    // visible from their record.
    try {
      await getAdminDb()
        .collection("contacts")
        .doc(contact.id)
        .collection("activities")
        .add({
          type: "email_sent",
          content: `Email (workflow): ${subject || "(no subject)"}`,
          createdBy: "workflow",
          meta: { messageId, subject: subject || "(no subject)" },
          createdAt: FieldValue.serverTimestamp(),
        });
    } catch (err) {
      console.warn("[workflows] email activity write failed", err);
    }
    return { result: { kind: "next" }, log: "ok" };
  } catch (err) {
    return {
      result: { kind: "next" },
      log: `error:${err instanceof Error ? err.message : "send_failed"}`,
    };
  }
};

const execSendSms: NodeExecutor = async (ctx) => {
  const cfg = ctx.node.config as unknown as SendSmsConfig;
  const contact = ctx.contact;
  if (smsSendBlock(contact))
    return { result: { kind: "next" }, log: "skipped:opt_out" };
  const to = contact.phone;
  if (!to) return { result: { kind: "next" }, log: "skipped:no_phone" };
  // Dedicated Twilio if configured, else shared env creds (same as contact-profile
  // SMS). The shared fallback only counts if the agency still allows it.
  const hasSms =
    subAccountTwilioIsConfigured(ctx.subAccount?.twilioConfig) ||
    (smsIsConfigured() &&
      (await agencyAllowsSharedSms(ctx.subAccount?.agencyId)));
  if (!hasSms) {
    return { result: { kind: "next" }, log: "error:sms_not_configured" };
  }
  const body = resolveMergeTags(cfg.body ?? "", mergeSubject(ctx, ""));
  return deliverWorkflowSms(ctx, to, body, "SMS (workflow)");
};

/** Send plus the activity, thread and inbox rows, shared by the SMS steps. */
async function deliverWorkflowSms(
  ctx: NodeContext,
  to: string,
  body: string,
  label: string,
): Promise<{ result: StepResult; log: string }> {
  const contact = ctx.contact;
  try {
    const sent = await sendSmsForSubAccount({
      subAccountId: ctx.subAccountId,
      subAccount: ctx.subAccount,
      to,
      body,
    });
    // Activity + inbox rows like the manual send route. Thread rows only in
    // dedicated mode: on the shared number inbound replies can't be tied to a
    // sub-account, so a thread would promise a two-way channel that doesn't exist.
    const preview = body.length > 80 ? `${body.slice(0, 80)}…` : body;
    const db = getAdminDb();
    try {
      await db
        .collection("contacts")
        .doc(contact.id)
        .collection("activities")
        .add({
          type: "sms_sent",
          content: `${label}: ${preview}`,
          createdBy: "workflow",
          meta: { sid: sent.sid, mode: sent.mode },
          createdAt: FieldValue.serverTimestamp(),
        });
    } catch (err) {
      console.warn("[workflows] sms activity write failed", err);
    }
    if (sent.mode === "dedicated") {
      try {
        await db
          .collection("contacts")
          .doc(contact.id)
          .collection("messages")
          .doc(sent.sid)
          .set({
            agencyId: ctx.agencyId,
            subAccountId: ctx.subAccountId,
            contactId: contact.id,
            direction: "outbound",
            status: "sent",
            body,
            from: sent.from,
            to,
            twilioMessageSid: sent.sid,
            sentByUid: "workflow",
            error: null,
            readAt: null,
            createdAt: FieldValue.serverTimestamp(),
          });
        // Dynamic import avoids a cycle (conversations-service imports this engine).
        // pauseBot false: an automated nudge isn't a human takeover, so the AI should
        // still answer the reply.
        const { upsertConversationForMessage } = await import(
          "@/lib/server/conversations-service"
        );
        await upsertConversationForMessage({
          contactId: contact.id,
          subAccountId: ctx.subAccountId,
          agencyId: ctx.agencyId,
          contactName: contact.name ?? "",
          contactPhone: to,
          channel: "sms",
          direction: "outbound",
          body,
          pauseBot: false,
        });
      } catch (err) {
        console.warn("[workflows] sms thread/inbox write failed", err);
      }
    }
    return { result: { kind: "next" }, log: "ok" };
  } catch (err) {
    if (err instanceof UsageQuotaExceededError) {
      return { result: { kind: "next" }, log: "skipped:quota" };
    }
    if (err instanceof SmsRecipientUnsubscribedError) {
      // Carrier says this number sent STOP (maybe before our webhook was wired).
      // Record it so run history explains the failure and later sends are blocked.
      try {
        const db = getAdminDb();
        await db.doc(`contacts/${contact.id}`).update({
          smsOptedOut: true,
          updatedAt: FieldValue.serverTimestamp(),
        });
        await db
          .collection("contacts")
          .doc(contact.id)
          .collection("activities")
          .add({
            type: "automation_step_skipped",
            content: `SMS refused by carrier — ${to} is unsubscribed (Twilio 21610).`,
            createdBy: "workflow",
            meta: { kind: "sms_opt_out", word: "21610", optedOut: true },
            createdAt: FieldValue.serverTimestamp(),
          });
      } catch (recordErr) {
        console.warn("[workflows] 21610 opt-out record failed", recordErr);
      }
      return { result: { kind: "next" }, log: "error:carrier_unsubscribed" };
    }
    return {
      result: { kind: "next" },
      log: `error:${err instanceof Error ? err.message : "send_failed"}`,
    };
  }
}

/** AI-written first text. Re-checks gate and readiness on every send: they can change after publishing. */
const execSendAiSms: NodeExecutor = async (ctx) => {
  const cfg = ctx.node.config as unknown as SendAiSmsConfig;
  const contact = ctx.contact;
  const instruction = (cfg.instruction ?? "").trim().slice(0, 1000);
  if (!instruction) {
    return { result: { kind: "next" }, log: "error:no_instruction" };
  }
  if (!ctx.subAccount || !aiOutboundSmsGateOn(ctx.subAccount)) {
    return { result: { kind: "next" }, log: "skipped:ai_sms_gate_off" };
  }
  if (smsSendBlock(contact)) {
    return { result: { kind: "next" }, log: "skipped:opt_out" };
  }
  const to = contact.phone;
  if (!to) return { result: { kind: "next" }, log: "skipped:no_phone" };

  const readiness = await aiOutboundSmsReadiness(
    ctx.subAccountId,
    ctx.subAccount,
  );
  const unmet = firstUnmet(readiness);
  if (unmet || !readiness.agent) {
    return {
      result: { kind: "next" },
      log: `skipped:not_ready:${unmet?.key ?? "agent"}`,
    };
  }
  const agent = readiness.agent;

  // A human who took over (or switched the bot off) owns this conversation;
  // in suggest mode the opener becomes a draft for a person to approve.
  const { getConversationControls, setConversationDraft } = await import(
    "@/lib/server/conversations-service"
  );
  const controls = await getConversationControls(contact.id);
  if (
    controls.botMode === "off" ||
    (controls.botPausedUntilMs && controls.botPausedUntilMs > Date.now())
  ) {
    return { result: { kind: "next" }, log: "skipped:bot_paused" };
  }

  // Wait for opening time, and don't open a conversation in the last half
  // hour when the agent couldn't answer the reply.
  const waitSeconds = secondsUntilAiCanConverse(
    agent.effective.hoursStart,
    agent.effective.hoursEnd,
    agent.effective.timezone,
  );
  if (waitSeconds > 0) {
    return { result: { kind: "retry", seconds: waitSeconds }, log: "deferred:outside_hours" };
  }

  // Both quotas before any tokens are spent.
  const quota = await checkQuotas({
    subAccountId: ctx.subAccountId,
    units: ["aiTokens", "aiReplies", "smsSegments"],
    subAccount: ctx.subAccount,
  });
  if (!quota.allowed) {
    return { result: { kind: "next" }, log: "skipped:quota" };
  }

  let opener: { text: string; tokens: number; model: string };
  try {
    opener = await generateAiOpener({
      subAccountId: ctx.subAccountId,
      agent,
      sub: ctx.subAccount,
      contact,
      instruction,
      appendOptOut: cfg.appendOptOut !== false,
    });
  } catch (err) {
    return {
      result: { kind: "next" },
      log: `error:ai_failed:${err instanceof Error ? err.message.slice(0, 120) : "unknown"}`,
    };
  }
  // Tokens always; the reply counts once delivered (a draft counts when an operator sends it).
  const countReply = (reply: boolean) =>
    runAfterResponse(() =>
      incrementChannelTokens(ctx.subAccountId, "sms", opener.tokens, { reply }),
    );
  if (controls.botMode === "suggest") {
    countReply(false);
    await setConversationDraft({
      contactId: contact.id,
      subAccountId: ctx.subAccountId,
      agencyId: ctx.agencyId,
      contactName: contact.name ?? "",
      contactPhone: to,
      channel: "sms",
      body: opener.text,
      model: opener.model,
      tokens: opener.tokens,
    });
    return { result: { kind: "next" }, log: "drafted:suggest_mode" };
  }
  const delivered = await deliverWorkflowSms(ctx, to, opener.text, "AI text (workflow)");
  countReply(delivered.log === "ok");
  return delivered;
};

const execWhatsappTemplate: NodeExecutor = async (ctx) => {
  const cfg = ctx.node.config as unknown as WhatsappTemplateConfig;
  const contact = ctx.contact;
  if (contact.whatsappOptedOut)
    return { result: { kind: "next" }, log: "skipped:opt_out" };
  const to = contact.phone;
  if (!to) return { result: { kind: "next" }, log: "skipped:no_phone" };
  // Needs the agency WhatsApp gate and a sender. The builder flags this too, but
  // the gate may have been turned off since.
  if (
    ctx.subAccount?.whatsappEnabledByAgency !== true ||
    !subAccountWhatsappIsConfigured(ctx.subAccount?.twilioConfig)
  ) {
    return { result: { kind: "next" }, log: "error:whatsapp_not_configured" };
  }
  if (!cfg.templateId)
    return { result: { kind: "next" }, log: "skipped:no_template" };

  const tplSnap = await getAdminDb()
    .doc(`subAccounts/${ctx.subAccountId}/whatsappTemplates/${cfg.templateId}`)
    .get();
  const tpl = tplSnap.exists ? (tplSnap.data() as WhatsappTemplateDoc) : null;
  if (!tpl || tpl.status !== "approved" || !tpl.contentSid) {
    // Deleted, never approved, or approval lost (paused/disabled).
    return { result: { kind: "next" }, log: "error:template_not_approved" };
  }

  const subject = mergeSubject(ctx, "");
  // Manual variable values may contain merge tags; resolve them first.
  const manualValues: Record<number, string> = {};
  for (const [pos, val] of Object.entries(cfg.manualValues ?? {})) {
    manualValues[Number(pos)] = resolveMergeTags(val ?? "", subject);
  }
  const contentVariables = resolveTemplateVariables({
    variables: tpl.variables,
    subject,
    manualValues,
  });

  try {
    await sendWhatsappTemplateForSubAccount({
      subAccountId: ctx.subAccountId,
      subAccount: ctx.subAccount,
      to,
      contentSid: tpl.contentSid,
      contentVariables,
    });
    return { result: { kind: "next" }, log: "ok" };
  } catch (err) {
    if (err instanceof UsageQuotaExceededError) {
      return { result: { kind: "next" }, log: "skipped:quota" };
    }
    return {
      result: { kind: "next" },
      log: `error:${err instanceof Error ? err.message : "send_failed"}`,
    };
  }
};

const execWait: NodeExecutor = async (ctx) => {
  const cfg = ctx.node.config as unknown as WaitConfig;
  const seconds = Math.max(0, Math.floor(cfg.seconds ?? 0));
  return { result: { kind: "wait", seconds }, log: `wait:${seconds}s` };
};

const execIfElse: NodeExecutor = async (ctx) => {
  const cfg = ctx.node.config as unknown as IfElseConfig;
  const pass = evalConditionGroup(cfg.conditions, ctx.contact);
  return { result: { kind: "branch", value: pass }, log: `branch:${pass}` };
};

const execGoal: NodeExecutor = async () => ({
  result: { kind: "end" },
  log: "goal",
});

const execAddTag: NodeExecutor = async (ctx) => {
  const tag = ((ctx.node.config as unknown as TagConfig).tag ?? "").trim();
  if (!tag) return { result: { kind: "next" }, log: "skipped:no_tag" };
  await getAdminDb()
    .doc(`contacts/${ctx.contact.id}`)
    .update({
      tags: FieldValue.arrayUnion(tag),
      updatedAt: FieldValue.serverTimestamp(),
    });
  return { result: { kind: "next" }, log: `tag+:${tag}` };
};

const execRemoveTag: NodeExecutor = async (ctx) => {
  const tag = ((ctx.node.config as unknown as TagConfig).tag ?? "").trim();
  if (!tag) return { result: { kind: "next" }, log: "skipped:no_tag" };
  await getAdminDb()
    .doc(`contacts/${ctx.contact.id}`)
    .update({
      tags: FieldValue.arrayRemove(tag),
      updatedAt: FieldValue.serverTimestamp(),
    });
  return { result: { kind: "next" }, log: `tag-:${tag}` };
};

const execMoveStage: NodeExecutor = async (ctx) => {
  const stage = (
    (ctx.node.config as unknown as MoveStageConfig).stage ?? ""
  ).trim();
  if (!stage) return { result: { kind: "next" }, log: "skipped:no_stage" };
  await getAdminDb()
    .doc(`contacts/${ctx.contact.id}`)
    .update({ pipelineStage: stage, updatedAt: FieldValue.serverTimestamp() });
  return { result: { kind: "next" }, log: `stage:${stage}` };
};

// Top-level fields a workflow may set, so a crafted config can't overwrite
// tenancy/system keys. customFields.* is open.
const WRITABLE_FIELDS = new Set([
  "name",
  "email",
  "phone",
  "company",
  "source",
  "pipelineStage",
]);

const execUpdateField: NodeExecutor = async (ctx) => {
  const cfg = ctx.node.config as unknown as UpdateFieldConfig;
  const field = (cfg.field ?? "").trim();
  if (!field) return { result: { kind: "next" }, log: "skipped:no_field" };
  if (!field.startsWith("customFields.") && !WRITABLE_FIELDS.has(field)) {
    return { result: { kind: "next" }, log: "skipped:field_not_writable" };
  }
  await getAdminDb()
    .doc(`contacts/${ctx.contact.id}`)
    .update({
      [field]: cfg.value ?? "",
      updatedAt: FieldValue.serverTimestamp(),
    });
  return { result: { kind: "next" }, log: `field:${field}` };
};

const execCreateTask: NodeExecutor = async (ctx) => {
  const cfg = ctx.node.config as unknown as CreateTaskConfig;
  const title =
    resolveMergeTags(cfg.title ?? "Follow up", mergeSubject(ctx, "")) ||
    "Follow up";
  const dueAt =
    cfg.dueInDays && cfg.dueInDays > 0
      ? new Date(Date.now() + cfg.dueInDays * 86_400_000)
      : null;
  await createTaskServerSide({
    subAccountId: ctx.subAccountId,
    agencyId: ctx.agencyId,
    createdByUid: ctx.createdByUid,
    mode: "live",
    title,
    notes: "Created by workflow",
    dueAt,
    contactId: ctx.contact.id,
    dealId: null,
    eventId: null,
  });
  return { result: { kind: "next" }, log: "task_created" };
};

/**
 * Who an internal notification goes to: the sub-account's account contact, or a
 * typed email. Falls back to the agency owner so it's never silently dropped
 * (including an account contact with no email).
 */
function resolveNotifyTo(cfg: NotifyConfig, ctx: NodeContext): string {
  const owner = ctx.owner.email;
  switch (cfg.recipient) {
    case "owner":
      return owner;
    case "account_contact":
      return ctx.subAccount?.accountContact?.email?.trim() || owner;
    // "custom" and unset both use the typed email, else owner.
    default:
      return (cfg.to ?? "").trim() || owner;
  }
}

const execNotify: NodeExecutor = async (ctx) => {
  const cfg = ctx.node.config as unknown as NotifyConfig;
  const to = resolveNotifyTo(cfg, ctx);
  if (!to) return { result: { kind: "next" }, log: "skipped:no_recipient" };
  if (!emailIsConfigured()) {
    return { result: { kind: "next" }, log: "error:email_not_configured" };
  }
  const subject = resolveMergeTags(
    cfg.subject ?? "Workflow notification",
    mergeSubject(ctx, "")
  );
  const text = resolveMergeTags(cfg.body ?? "", mergeSubject(ctx, ""));
  const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,sans-serif;line-height:1.6;color:#1a1a1a;max-width:600px;margin:0 auto;padding:24px;">${text.replace(
    /\r?\n/g,
    "<br>"
  )}</body></html>`;
  try {
    await sendEmail({
      to,
      subject: subject || "Workflow notification",
      text,
      html,
      from: tenantFrom(ctx.subAccount),
      subAccount: ctx.subAccount,
      meter: { subAccountId: ctx.subAccountId },
    });
    return { result: { kind: "next" }, log: "ok" };
  } catch (err) {
    return {
      result: { kind: "next" },
      log: `error:${err instanceof Error ? err.message : "send_failed"}`,
    };
  }
};

const execWebhook: NodeExecutor = async (ctx) => {
  const url = ((ctx.node.config as unknown as WebhookConfig).url ?? "").trim();
  if (!/^https?:\/\//i.test(url)) {
    return { result: { kind: "next" }, log: "skipped:bad_url" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  // Form answers (label -> value) from enrollment; {} for non-form triggers.
  const tc = ctx.triggerContext ?? {};
  const formData =
    tc.formData && typeof tc.formData === "object"
      ? (tc.formData as Record<string, unknown>)
      : {};
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "workflow.webhook",
        contact: {
          id: ctx.contact.id,
          name: ctx.contact.name,
          email: ctx.contact.email,
          phone: ctx.contact.phone,
        },
        form: {
          id: typeof tc.formId === "string" ? tc.formId : null,
          name: typeof tc.formName === "string" ? tc.formName : null,
          fields: formData,
        },
      }),
      signal: controller.signal,
    });
    return { result: { kind: "next" }, log: "ok" };
  } catch (err) {
    return {
      result: { kind: "next" },
      log: `error:${err instanceof Error ? err.message : "webhook_failed"}`,
    };
  } finally {
    clearTimeout(timer);
  }
};

/** Unknown node types pass through instead of stalling. */
const execPassThrough: NodeExecutor = async () => ({
  result: { kind: "next" },
  log: "unsupported_passthrough",
});

const REGISTRY: Partial<Record<WorkflowNodeType, NodeExecutor>> = {
  send_email: execSendEmail,
  send_sms: execSendSms,
  send_ai_sms: execSendAiSms,
  whatsapp_template: execWhatsappTemplate,
  wait: execWait,
  if_else: execIfElse,
  goal: execGoal,
  add_tag: execAddTag,
  remove_tag: execRemoveTag,
  move_stage: execMoveStage,
  update_field: execUpdateField,
  create_task: execCreateTask,
  notify: execNotify,
  webhook: execWebhook,
};

// Dispatch

interface FireInput {
  subAccountId: string;
  agencyId: string;
  type: WorkflowTriggerType;
  contactId: string;
  context?: Record<string, unknown>;
}

/**
 * Enroll the contact in every active workflow matching the trigger + filters.
 * Never throws; a workflow problem must not break the triggering action.
 * Callers usually `void` this, so the work is handed to runAfterResponse()
 * synchronously (or Vercel may freeze it). Resolves once scheduled, not done.
 */
export async function fireWorkflowTrigger(input: FireInput): Promise<void> {
  runAfterResponse(() => runFireWorkflowTrigger(input));
}

async function runFireWorkflowTrigger(input: FireInput): Promise<void> {
  const db = getAdminDb();
  try {
    const subSnap = await db.doc(`subAccounts/${input.subAccountId}`).get();
    if (subSnap.data()?.automationsPaused === true) return;

    const matches = await db
      .collection("workflows")
      .where("subAccountId", "==", input.subAccountId)
      .where("status", "==", "active")
      .where("trigger.type", "==", input.type)
      .get();
    if (matches.empty) return;

    const contactSnap = await db.doc(`contacts/${input.contactId}`).get();
    if (!contactSnap.exists) return;
    const contact = {
      id: contactSnap.id,
      ...(contactSnap.data() as Omit<Contact, "id">),
    };

    for (const doc of matches.docs) {
      const wf = { id: doc.id, ...(doc.data() as Omit<WorkflowDoc, "id">) };
      if (!wf.startNodeId) continue;

      if (
        wf.trigger.type === "form.submitted" &&
        wf.trigger.formId &&
        wf.trigger.formId !== input.context?.formId
      ) {
        continue;
      }
      if (wf.trigger.type === "pipeline.stage.changed") {
        if (
          wf.trigger.toStage &&
          wf.trigger.toStage !== input.context?.toStage
        ) {
          continue;
        }
        // A stage filter without toPipeline means the default pipeline, so it never
        // fires for a same-named stage in a custom pipeline.
        if (wf.trigger.toStage || wf.trigger.toPipeline) {
          const want = wf.trigger.toPipeline || "default";
          const got = (input.context?.toPipeline as string) || "default";
          if (want !== got) continue;
        }
      }
      if (
        wf.trigger.type === "message.received" &&
        wf.trigger.channel &&
        wf.trigger.channel !== input.context?.channel
      ) {
        continue;
      }
      if (
        (wf.trigger.type === "email.opened" ||
          wf.trigger.type === "email.clicked") &&
        wf.trigger.broadcastId &&
        wf.trigger.broadcastId !== input.context?.broadcastId
      ) {
        continue;
      }
      if (!evalConditionGroup(wf.trigger.filters, contact)) continue;
      if (!(await reentryAllows(wf, contact.id))) continue;

      await enroll(wf, contact.id, input.context ?? {});
    }
  } catch (err) {
    console.error("[workflows] fireWorkflowTrigger failed", err);
  }
}

/**
 * Re-enrollment policy. "every_time" (the default) never blocks. Equality query
 * plus in-memory status filter; contacts have few runs per workflow. Fails open
 * so a read error can't silently stop enrollments.
 */
async function reentryAllows(
  wf: WorkflowDoc,
  contactId: string
): Promise<boolean> {
  const policy = wf.reentry ?? "every_time";
  if (policy === "every_time") return true;
  try {
    const snap = await getAdminDb()
      .collection("workflowRuns")
      .where("workflowId", "==", wf.id)
      .where("contactId", "==", contactId)
      .get();
    if (snap.empty) return true;
    if (policy === "once_ever") return false;
    // unless_active: block only while a run is live.
    return !snap.docs.some((d) => {
      const s = (d.data() as WorkflowRunDoc).status;
      return s === "running" || s === "waiting";
    });
  } catch (err) {
    console.warn("[workflows] reentry check failed — allowing", err);
    return true;
  }
}

async function enroll(
  wf: WorkflowDoc,
  contactId: string,
  context: Record<string, unknown>
): Promise<void> {
  const db = getAdminDb();
  const runRef = db.collection("workflowRuns").doc();
  await runRef.set({
    id: runRef.id,
    subAccountId: wf.subAccountId,
    agencyId: wf.agencyId,
    workflowId: wf.id,
    contactId,
    status: "running",
    currentNodeId: wf.startNodeId,
    history: [],
    context,
    qstashMessageId: null,
    enrolledAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  await db
    .doc(`workflows/${wf.id}`)
    .update({ "stats.enrolled": FieldValue.increment(1) })
    .catch(() => {});

  if (!qstashIsConfigured()) {
    await runRef.update({ status: "failed" });
    return;
  }
  await scheduleNode(runRef, wf.startNodeId!, 0);
}

// Run worker

async function scheduleNode(
  runRef: FirebaseFirestore.DocumentReference,
  nodeId: string,
  delaySeconds: number,
  /** Re-running the same node needs its own id or QStash drops it as a duplicate. */
  dedupSuffix?: string
): Promise<void> {
  const res = await publishCallback({
    pathname: STEP_PATH,
    body: { runId: runRef.id, nodeId },
    delaySeconds,
    deduplicationId: `wf_${runRef.id}_${nodeId}${dedupSuffix ? `_${dedupSuffix}` : ""}`,
  });
  if (!res) {
    await runRef.update({
      status: "failed",
      updatedAt: FieldValue.serverTimestamp(),
    });
    return;
  }
  await runRef.update({
    currentNodeId: nodeId,
    status: delaySeconds > 0 ? "waiting" : "running",
    qstashMessageId: res.messageId,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

async function completeRun(
  runRef: FirebaseFirestore.DocumentReference,
  workflowId: string
): Promise<void> {
  await runRef.update({
    status: "completed",
    currentNodeId: null,
    updatedAt: FieldValue.serverTimestamp(),
  });
  await getAdminDb()
    .doc(`workflows/${workflowId}`)
    .update({ "stats.completed": FieldValue.increment(1) })
    .catch(() => {});
}

/** Advance one node of a run. Idempotent on the run's history. */
export async function runStep(
  runId: string,
  nodeId: string,
  phase?: "timeout"
): Promise<void> {
  const db = getAdminDb();
  const runRef = db.collection("workflowRuns").doc(runId);
  const runSnap = await runRef.get();
  if (!runSnap.exists) return;
  const run = runSnap.data() as WorkflowRunDoc;

  if (run.status !== "running" && run.status !== "waiting") return;
  if (run.history.some((h) => h.nodeId === nodeId)) return; // QStash retry

  const wfSnap = await db.doc(`workflows/${run.workflowId}`).get();
  if (!wfSnap.exists) {
    await runRef.update({
      status: "failed",
      updatedAt: FieldValue.serverTimestamp(),
    });
    return;
  }
  const wf = wfSnap.data() as WorkflowDoc;
  // Test runs ignore status so drafts can be dry-run.
  if (wf.status !== "active" && run.context?.test !== true) {
    await runRef.update({
      status: "exited",
      updatedAt: FieldValue.serverTimestamp(),
    });
    return;
  }

  const node = wf.nodes[nodeId];
  if (!node) {
    await completeRun(runRef, wf.id);
    return;
  }

  // Two-phase node outside the registry: arm (park + schedule a timeout), then
  // resolved by either an inbound reply or the timeout callback.
  if (node.type === "wait_for_reply") {
    await stepWaitForReply(runRef, run, wf, node, phase);
    return;
  }

  const contactSnap = await db.doc(`contacts/${run.contactId}`).get();
  if (!contactSnap.exists) {
    await runRef.update({
      status: "failed",
      updatedAt: FieldValue.serverTimestamp(),
    });
    return;
  }
  const contact = {
    id: contactSnap.id,
    ...(contactSnap.data() as Omit<Contact, "id">),
  };

  const [subSnap, agencySnap] = await Promise.all([
    db.doc(`subAccounts/${run.subAccountId}`).get(),
    db.doc(`agencies/${run.agencyId}`).get(),
  ]);
  const subAccount = subSnap.exists ? (subSnap.data() as SubAccountDoc) : null;
  const agency = agencySnap.exists ? (agencySnap.data() as AgencyDoc) : null;

  if (subAccount?.automationsPaused === true) {
    await runRef.update({
      status: "exited",
      updatedAt: FieldValue.serverTimestamp(),
    });
    return;
  }

  const owner = await loadOwner(agency);
  const exec = REGISTRY[node.type] ?? execPassThrough;
  const { result, log } = await exec({
    node,
    contact,
    subAccount,
    owner,
    subAccountId: run.subAccountId,
    agencyId: run.agencyId,
    createdByUid: wf.createdByUid,
    triggerContext: run.context ?? {},
  });

  // No history entry: history marks a node as done, and the retry must run it.
  // The suffix is the target hour so a redelivered callback collapses into the
  // same QStash message instead of starting a second chain.
  const retries = run.retryCounts?.[nodeId] ?? 0;
  if (result.kind === "retry" && retries < MAX_NODE_RETRIES) {
    const targetHour = Math.floor((Date.now() + result.seconds * 1000) / 3_600_000);
    await runRef.update({
      [`retryCounts.${nodeId}`]: FieldValue.increment(1),
      deferNote: `${NODE_LABEL_FOR_LOG[node.type] ?? node.type}: ${log}, until ${new Date(targetHour * 3_600_000).toISOString().slice(0, 16).replace("T", " ")} UTC`,
    });
    await scheduleNode(runRef, nodeId, result.seconds, `r${targetHour}`);
    return;
  }

  const entry: WorkflowRunHistoryEntry = {
    nodeId,
    type: node.type,
    at: Timestamp.now(),
    result: result.kind === "retry" ? `skipped:retry_limit:${log}` : log,
  };
  await runRef.update({
    history: FieldValue.arrayUnion(entry),
    deferNote: null,
    updatedAt: FieldValue.serverTimestamp(),
  });

  let target: string | null = null;
  let delay = 0;
  if (result.kind === "end") {
    await completeRun(runRef, wf.id);
    return;
  } else if (result.kind === "branch") {
    const b = node.branches;
    target = (result.value ? b?.whenTrue : b?.whenFalse) ?? null;
  } else if (result.kind === "wait") {
    target = node.next ?? null;
    delay = result.seconds;
  } else {
    // "next", or a retry that hit the cap.
    target = node.next ?? null;
  }

  if (!target) {
    await completeRun(runRef, wf.id);
    return;
  }
  await scheduleNode(runRef, target, delay);
}

// wait_for_reply

/**
 * Two-phase wait_for_reply.
 *
 * Arm (no `phase`): stamp run.waiting, park the run, schedule a timeout that
 * re-enters this node with phase "timeout". No history entry here: history is
 * the resolution marker, and adding one would make the idempotency guard treat
 * the node as resolved.
 *
 * Timeout: claim the node in a transaction (re-checking waiting + history, since
 * a reply may have won), then take the No-reply branch.
 *
 * A QStash retry of the arm re-runs it safely: the timeout publish is deduped by
 * id and the re-stamp is idempotent.
 */
async function stepWaitForReply(
  runRef: FirebaseFirestore.DocumentReference,
  run: WorkflowRunDoc,
  wf: WorkflowDoc,
  node: WorkflowNode,
  phase: "timeout" | undefined
): Promise<void> {
  const db = getAdminDb();

  if (phase !== "timeout") {
    // Arm. Stamp `waiting` before publishing the timeout so the callback never sees
    // an unstamped run; a crash between the writes is fixed by QStash's retry.
    const cfg = node.config as unknown as WaitForReplyConfig;
    const seconds = Math.max(60, Math.floor(cfg.seconds ?? 0));
    await runRef.update({
      waiting: {
        nodeId: node.id,
        kind: "reply",
        since: Timestamp.now(),
        until: Timestamp.fromMillis(Date.now() + seconds * 1000),
      },
      status: "waiting",
      currentNodeId: node.id,
      updatedAt: FieldValue.serverTimestamp(),
    });
    const res = await publishCallback({
      pathname: STEP_PATH,
      body: { runId: run.id, nodeId: node.id, phase: "timeout" },
      delaySeconds: seconds,
      deduplicationId: `wf_${run.id}_${node.id}_timeout`,
    });
    if (!res) {
      await runRef.update({
        waiting: null,
        status: "failed",
        updatedAt: FieldValue.serverTimestamp(),
      });
      return;
    }
    await runRef.update({ qstashMessageId: res.messageId });
    return;
  }

  // Timeout: claim, then take the No-reply branch.
  const claimed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(runRef);
    if (!snap.exists) return false;
    const r = snap.data() as WorkflowRunDoc;
    if (r.waiting?.nodeId !== node.id) return false; // a reply won the race
    if (r.history.some((h) => h.nodeId === node.id)) return false;
    const entry: WorkflowRunHistoryEntry = {
      nodeId: node.id,
      type: node.type,
      at: Timestamp.now(),
      result: "timeout",
    };
    tx.update(runRef, {
      waiting: null,
      status: "running",
      history: FieldValue.arrayUnion(entry),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return true;
  });
  if (!claimed) return;

  const target = node.branches?.whenFalse ?? null;
  if (!target) {
    await completeRun(runRef, wf.id);
    return;
  }
  await scheduleNode(runRef, target, 0);
}

/**
 * The contact replied: resolve their runs parked on wait_for_reply. Called from
 * the inbox upsert for every inbound message on a known contact; there is no
 * channel filter here, so inbox email and captured web chat count too.
 * Equality-only query, no index. Never throws.
 */
export async function resumeWaitingRunsOnReply(input: {
  subAccountId: string;
  contactId: string;
  channel: string;
}): Promise<void> {
  try {
    const db = getAdminDb();
    const snap = await db
      .collection("workflowRuns")
      .where("contactId", "==", input.contactId)
      .where("status", "==", "waiting")
      .get();
    if (snap.empty) return;

    for (const doc of snap.docs) {
      const run = doc.data() as WorkflowRunDoc;
      if (run.subAccountId !== input.subAccountId) continue;
      const waiting = run.waiting;
      if (!waiting || waiting.kind !== "reply") continue; // plain timer wait
      const nodeId = waiting.nodeId;

      const claimed = await db.runTransaction(async (tx) => {
        const s = await tx.get(doc.ref);
        if (!s.exists) return false;
        const r = s.data() as WorkflowRunDoc;
        if (r.waiting?.nodeId !== nodeId) return false; // timeout won the race
        if (r.history.some((h) => h.nodeId === nodeId)) return false;
        const entry: WorkflowRunHistoryEntry = {
          nodeId,
          type: "wait_for_reply",
          at: Timestamp.now(),
          result: `replied:${input.channel}`,
        };
        tx.update(doc.ref, {
          waiting: null,
          status: "running",
          history: FieldValue.arrayUnion(entry),
          updatedAt: FieldValue.serverTimestamp(),
        });
        return true;
      });
      if (!claimed) continue;

      const wfSnap = await db.doc(`workflows/${run.workflowId}`).get();
      const wf = wfSnap.exists ? (wfSnap.data() as WorkflowDoc) : null;
      const target = wf?.nodes?.[nodeId]?.branches?.whenTrue ?? null;
      if (!target) {
        await completeRun(doc.ref, run.workflowId);
        continue;
      }
      await scheduleNode(doc.ref, target, 0);
    }
  } catch (err) {
    console.warn("[workflows] resumeWaitingRunsOnReply failed", err);
  }
}

/** Dry-run: enroll one contact, ignoring trigger/filters; works on drafts. */
export async function enrollForTest(opts: {
  subAccountId: string;
  workflowId: string;
  contactId: string;
}): Promise<{ ok: boolean; error?: string }> {
  const db = getAdminDb();
  const wfSnap = await db.doc(`workflows/${opts.workflowId}`).get();
  if (!wfSnap.exists) return { ok: false, error: "Workflow not found" };
  const wf = { id: wfSnap.id, ...(wfSnap.data() as Omit<WorkflowDoc, "id">) };
  if (wf.subAccountId !== opts.subAccountId) {
    return { ok: false, error: "Workflow not found" };
  }
  if (!wf.startNodeId)
    return { ok: false, error: "Add at least one step first" };
  const cSnap = await db.doc(`contacts/${opts.contactId}`).get();
  if (!cSnap.exists || cSnap.data()!.subAccountId !== opts.subAccountId) {
    return { ok: false, error: "Contact not found" };
  }
  await enroll(wf, opts.contactId, { test: true });
  return { ok: true };
}

async function loadOwner(
  agency: AgencyDoc | null
): Promise<{ displayName: string; email: string }> {
  if (!agency?.ownerUid) return { displayName: "", email: "" };
  try {
    const snap = await getAdminDb().doc(`users/${agency.ownerUid}`).get();
    const d = snap.data();
    return {
      displayName: (d?.displayName as string) ?? "",
      email: (d?.email as string) ?? "",
    };
  } catch {
    return { displayName: "", email: "" };
  }
}
