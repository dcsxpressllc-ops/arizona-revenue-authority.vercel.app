import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { createTaskServerSide } from "@/lib/server/tasks-service";
import type { SubAccountDoc } from "@/types";
import { resolveAgent, type ConfiguredChannelId } from "@/lib/comms/ai/agent";
import { emailIsConfigured, sendEmail, tenantFrom } from "@/lib/comms/resend";

/**
 * After web chat or voice reconciles a Contact: create a follow-up Task due
 * end of today and email the agent's notify address (channel override, else
 * profile default). Never throws; failures go in `errors` so the user-facing
 * reply isn't blocked.
 */

interface CreateCaptureFollowUpInput {
  agencyId: string;
  subAccountId: string;
  channelId: ConfiguredChannelId;
  /** "Web Chat" / "Voice", for the Task title and email subject. */
  channelLabel: string;
  /** Task title verb. */
  taskAction: "Follow up with" | "Call back";
  /** Word used in notes and the email link label. */
  sessionNoun: "session" | "call";
  /** sessionId (web chat) or callId (voice). Put in Task notes so the operator can find the source. */
  sessionId: string;
  /** Dashboard path to the session/call view. null makes the email link to the contact only. */
  sessionDeepLinkPath: string | null;
  contactId: string;
  capturedName: string | null;
  capturedEmail: string | null;
  capturedPhone: string | null;
  /** Visitor's last message (web chat) or the end-of-call summary (voice), quoted in the email. */
  lastInboundMessage: string | null;
  /** Web chat: page URL. Voice: null. */
  pageUrl: string | null;
}

export interface CaptureFollowUpResult {
  taskId: string | null;
  emailSent: boolean;
  errors: string[];
}

export async function createCaptureFollowUp(
  input: CreateCaptureFollowUpInput,
): Promise<CaptureFollowUpResult> {
  const errors: string[] = [];

  const identity =
    input.capturedName ||
    input.capturedEmail ||
    input.capturedPhone ||
    `Anonymous ${input.channelLabel.toLowerCase()} lead`;

  // 1. Task
  let taskId: string | null = null;
  try {
    const now = new Date();
    const dueAt = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      23,
      59,
      59,
    );

    const notes = [
      `Captured from ${input.channelLabel} ${input.sessionNoun}: ${input.sessionId}`,
      input.pageUrl ? `Page: ${input.pageUrl}` : null,
      input.capturedEmail ? `Email: ${input.capturedEmail}` : null,
      input.capturedPhone ? `Phone: ${input.capturedPhone}` : null,
      input.lastInboundMessage
        ? `\nLast ${input.sessionNoun === "call" ? "call summary" : "visitor message"}:\n"${input.lastInboundMessage}"`
        : null,
    ]
      .filter(Boolean)
      .join("\n");

    // Use the shared helper, not a raw tasks.add(): it emits task.created and sets
    // `mode`, without which the public API's mode filter can't see the task.
    // Territory is resolved from the contact inside.
    const created = await createTaskServerSide({
      subAccountId: input.subAccountId,
      agencyId: input.agencyId,
      createdByUid: `${input.channelId}-bot`,
      mode: "live",
      title: `${input.taskAction} ${identity} from ${input.channelLabel}`,
      notes,
      dueAt,
      contactId: input.contactId,
      dealId: null,
      eventId: null,
    });
    taskId = created.id;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(
      `[ai/follow-up] task create failed sa=${input.subAccountId} channel=${input.channelId}`,
      err,
    );
    errors.push(`task: ${msg}`);
  }

  // 2. Escalation email
  let emailSent = false;
  if (!emailIsConfigured()) {
    errors.push("email: not configured");
  } else {
    try {
      const db = getAdminDb();
      const [agent, subSnap] = await Promise.all([
        resolveAgent(input.subAccountId, input.channelId),
        db.doc(`subAccounts/${input.subAccountId}`).get(),
      ]);
      const subAccount = subSnap.data() as SubAccountDoc | undefined;
      const to = agent?.effective.escalationNotifyEmail?.trim();
      if (!to) {
        errors.push("email: no escalation address configured");
      } else {
        const appUrl =
          process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://leadstack.dev";
        const sessionUrl = input.sessionDeepLinkPath
          ? `${appUrl}${input.sessionDeepLinkPath}`
          : null;
        const contactUrl = `${appUrl}/sa/${input.subAccountId}/contacts/${input.contactId}`;

        const subject = `New ${input.channelLabel} lead: ${identity}`;
        const businessName =
          agent?.effective.businessName?.trim() || "your business";

        const html = renderCaptureEmail({
          channelLabel: input.channelLabel,
          sessionNoun: input.sessionNoun,
          businessName,
          identity,
          capturedName: input.capturedName,
          capturedEmail: input.capturedEmail,
          capturedPhone: input.capturedPhone,
          pageUrl: input.pageUrl,
          lastInboundMessage: input.lastInboundMessage,
          sessionUrl,
          contactUrl,
        });

        const text = [
          `New ${input.channelLabel} lead — ${identity}`,
          "",
          input.capturedName ? `Name: ${input.capturedName}` : null,
          input.capturedEmail ? `Email: ${input.capturedEmail}` : null,
          input.capturedPhone ? `Phone: ${input.capturedPhone}` : null,
          input.pageUrl ? `Page: ${input.pageUrl}` : null,
          input.lastInboundMessage
            ? `\nLatest ${input.sessionNoun === "call" ? "call summary" : "message"}:\n${input.lastInboundMessage}`
            : null,
          "",
          sessionUrl ? `${capitalize(input.sessionNoun)}: ${sessionUrl}` : null,
          `Contact: ${contactUrl}`,
          "",
          "A follow-up task has been created in your Tasks list, due today.",
        ]
          .filter((s): s is string => s !== null)
          .join("\n");

        await sendEmail({
          to,
          subject,
          text,
          html,
          from: tenantFrom(subAccount),
          subAccount,
          meter: { subAccountId: input.subAccountId },
        });
        emailSent = true;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error(
        `[ai/follow-up] email send failed sa=${input.subAccountId} channel=${input.channelId}`,
        err,
      );
      errors.push(`email: ${msg}`);
    }
  }

  return { taskId, emailSent, errors };
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

function renderCaptureEmail(input: {
  channelLabel: string;
  sessionNoun: "session" | "call";
  businessName: string;
  identity: string;
  capturedName: string | null;
  capturedEmail: string | null;
  capturedPhone: string | null;
  pageUrl: string | null;
  lastInboundMessage: string | null;
  sessionUrl: string | null;
  contactUrl: string;
}): string {
  const detailsTable = [
    input.capturedName ? ["Name", esc(input.capturedName)] : null,
    input.capturedEmail
      ? [
          "Email",
          `<a href="mailto:${esc(input.capturedEmail)}">${esc(input.capturedEmail)}</a>`,
        ]
      : null,
    input.capturedPhone
      ? [
          "Phone",
          `<a href="tel:${esc(input.capturedPhone)}">${esc(input.capturedPhone)}</a>`,
        ]
      : null,
    input.pageUrl ? ["Page", `<a href="${esc(input.pageUrl)}">${esc(input.pageUrl)}</a>`] : null,
  ]
    .filter((r): r is [string, string] => r !== null)
    .map(
      ([k, v]) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#64748b;font-size:13px;">${esc(k)}</td><td style="padding:4px 0;font-size:13px;">${v}</td></tr>`,
    )
    .join("");

  const lastMsgLabel =
    input.sessionNoun === "call" ? "Call summary" : "Latest message";
  const lastMsgBlock = input.lastInboundMessage
    ? `<div style="margin-top:20px;padding:12px 14px;background:#f8fafc;border-left:3px solid #7c3aed;border-radius:4px;">
         <div style="font-size:11px;text-transform:uppercase;color:#64748b;letter-spacing:0.05em;margin-bottom:6px;">${esc(lastMsgLabel)}</div>
         <div style="font-size:14px;color:#0f172a;white-space:pre-wrap;">${esc(input.lastInboundMessage)}</div>
       </div>`
    : "";

  const sessionButton = input.sessionUrl
    ? `<a href="${esc(input.sessionUrl)}" style="display:inline-block;background:#7c3aed;color:white;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:13px;font-weight:600;">Open ${esc(input.channelLabel.toLowerCase())} ${esc(input.sessionNoun)}</a>`
    : "";

  return `<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f1f5f9;margin:0;padding:24px;">
  <div style="max-width:560px;margin:0 auto;background:white;border-radius:12px;padding:28px;">
    <div style="font-size:11px;text-transform:uppercase;color:#7c3aed;letter-spacing:0.08em;font-weight:600;">New ${esc(input.channelLabel)} lead</div>
    <h1 style="margin:8px 0 4px;font-size:20px;color:#0f172a;">${esc(input.identity)} just reached out</h1>
    <p style="margin:0 0 20px;color:#64748b;font-size:14px;">A ${esc(input.sessionNoun === "call" ? "caller" : "visitor")} on ${esc(input.businessName)}'s ${esc(input.sessionNoun === "call" ? "phone line" : "site")} shared their contact details via the AI ${esc(input.channelLabel.toLowerCase())} agent.</p>
    <table style="border-collapse:collapse;width:100%;">${detailsTable}</table>
    ${lastMsgBlock}
    <div style="margin-top:24px;display:flex;gap:8px;">
      ${sessionButton}
      <a href="${esc(input.contactUrl)}" style="display:inline-block;background:transparent;color:#7c3aed;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:13px;font-weight:600;border:1px solid #c4b5fd;">View contact</a>
    </div>
    <p style="margin:24px 0 0;color:#94a3b8;font-size:11px;">A follow-up task has been created in your Tasks list, due today.</p>
  </div>
</body></html>`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
