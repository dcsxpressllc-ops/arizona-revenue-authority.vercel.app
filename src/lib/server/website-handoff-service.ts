import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  getAgentProfile,
  getChannelConfig,
  upsertAgentProfile,
  upsertChannelConfig,
} from "@/lib/comms/ai/agent";
import { aiChannelGateOn } from "@/lib/comms/ai/gates";
import { aiIsConfigured } from "@/lib/comms/ai/openrouter";
import { emailIsConfigured } from "@/lib/comms/resend";
import {
  smsIsConfigured,
  subAccountTwilioIsConfigured,
} from "@/lib/comms/twilio";
import { qstashIsConfigured } from "@/lib/automations/qstash";
import { updateWebVoiceSettings } from "@/lib/server/web-voice-service";
import { sendPushForEvent } from "@/lib/push/send";
import {
  createWorkflowServerSide,
  updateWorkflowServerSide,
} from "@/lib/server/workflows-service";
import { DEFAULT_WEB_CHAT_CONFIG, type AiAgentProfile } from "@/types/ai";
import type { AgencyDoc, SubAccountDoc } from "@/types/tenancy";
import type { WorkflowDoc, WorkflowNode } from "@/types/workflows";
import {
  wantsChatWidget,
  wantsWebVoice,
  wantsLeadForm,
  type WebsiteConfig,
  type WebsiteDoc,
  type WebsiteProvisioning,
} from "@/types/website";
import type { PollBuildResult } from "@/lib/gitpage/client";

/**
 * Follow-on setup when a premium gitpage build publishes, so the site works the
 * moment it's live: chat widget, contact form into the CRM, speed-to-lead.
 *
 * Each step is independent and best-effort (failures go to
 * `provisioning.errors`, the site stays published), and the whole thing is
 * idempotent across rebuilds and duplicate callbacks:
 *   1. Add the live hostname to `webChat.allowedDomains`.
 *   2. Seed aiAgent/profile with gitpage's kbText and fill blank persona fields.
 *   3. Turn the web-chat bot on, unless OpenRouter is missing or the agency
 *      gate is explicitly off.
 *   4. One speed-to-lead workflow pinned to the site's form. Channel steps the
 *      deployment can't send are dropped; published only if a customer-facing
 *      channel is ready and QStash is configured, otherwise left as draft.
 *   5. Push the team (silent without VAPID).
 */

const KB_MAX_CHARS = 6000;
const WEBSITE_FORM_NAME = "Website contact";

/** Stamped on the provisioned workflow for idempotency. */
export const WEBSITE_WORKFLOW_SOURCE = "website-build";

export interface HandoffInput {
  subAccountId: string;
  siteId: string;
  site: WebsiteDoc;
  config: WebsiteConfig;
  liveUrl: string;
  result: PollBuildResult;
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The sub-account's single "Website contact" form, reused across sites and
 *  rebuilds so the speed-to-lead workflow has one anchor. */
export async function ensureWebsiteContactForm(input: {
  subAccountId: string;
  createdByUid: string;
  /** Reused if it still exists. */
  existingFormId?: string | null;
}): Promise<string> {
  const db = getAdminDb();
  if (input.existingFormId) {
    const snap = await db.doc(`forms/${input.existingFormId}`).get();
    if (snap.exists && snap.data()?.subAccountId === input.subAccountId) {
      return input.existingFormId;
    }
  }
  const existing = await db
    .collection("forms")
    .where("subAccountId", "==", input.subAccountId)
    .where("name", "==", WEBSITE_FORM_NAME)
    .limit(1)
    .get();
  if (!existing.empty) return existing.docs[0].id;

  // Lazy import keeps the forms service out of the client graph.
  const { createFormServerSide } = await import("@/lib/server/forms-service");
  return createFormServerSide({
    subAccountId: input.subAccountId,
    createdByUid: input.createdByUid,
    name: WEBSITE_FORM_NAME,
    template: "contact",
  });
}

/**
 * Follow redirects and return where the URL lands. Browsers can't follow these
 * hops on cross-origin calls:
 *   - an apex NEXT_PUBLIC_APP_URL that 307s to www fails the CORS preflight
 *     ("Failed to fetch", silent widget)
 *   - gitpage reports GitLab's path URL (user.gitlab.io/repo), which 308s to
 *     the unique domain visitors load and the chat allowlist needs.
 * Never throws; returns the input on failure (3s budget).
 */
export async function resolveFinalUrl(url: string, probePath = ""): Promise<string> {
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}${probePath}`, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(3000),
      cache: "no-store",
    });
    const final = res.url;
    if (!final) return url;
    return probePath && final.endsWith(probePath) ? final.slice(0, -probePath.length) : final;
  } catch {
    return url;
  }
}

/** Never a published site: git hosts' own pages and the GitLab Pages auth login. */
const NON_SITE_HOSTS = new Set([
  "gitlab.com",
  "www.gitlab.com",
  "projects.gitlab.io",
  "github.com",
  "www.github.com",
]);

export function isPlausibleSiteUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    if (NON_SITE_HOSTS.has(u.hostname.toLowerCase())) return false;
    return !/^\/users\/sign_in\b/.test(u.pathname);
  } catch {
    return false;
  }
}

/**
 * Live address for a just-published site: the Pages URL with redirects
 * resolved, but only if it lands on a real site. GitLab Pages access control can
 * briefly redirect a new project to gitlab.com/users/sign_in, which must never
 * become the live URL or allowlist host. Otherwise keep the reported URL.
 */
export async function resolveLiveUrl(pagesUrl: string): Promise<string> {
  if (!isPlausibleSiteUrl(pagesUrl)) {
    console.warn(`[website] gitpage reported a non-site live URL: ${pagesUrl}`);
    return pagesUrl;
  }
  const final = await resolveFinalUrl(pagesUrl);
  return isPlausibleSiteUrl(final) ? final : pagesUrl;
}

/** Public https origin with redirects resolved (apex -> www), or null. */
export async function resolvedAppUrl(): Promise<string | null> {
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim().replace(/\/$/, "");
  if (!/^https:\/\/[^\s/]+$/i.test(appUrl)) return null;
  const final = await resolveFinalUrl(appUrl, "/widget.js");
  try {
    const origin = new URL(final).origin;
    return /^https:\/\//.test(origin) ? origin : appUrl;
  } catch {
    return appUrl;
  }
}

/** LeadStack endpoints baked into a premium site. Null if the app URL isn't public https. */
export function leadstackWiringFor(input: {
  subAccountId: string;
  formId: string | null;
  config: WebsiteConfig;
  /** Pass `resolvedAppUrl()` so no baked URL redirects. */
  appUrl?: string | null;
}): {
  appUrl: string;
  subAccountId: string;
  formId?: string;
  formSubmitUrl?: string;
  widgetScriptUrl?: string;
} | null {
  const appUrl = (input.appUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? "").trim().replace(/\/$/, "");
  if (!/^https:\/\/[^\s/]+$/i.test(appUrl)) return null;
  return {
    appUrl,
    subAccountId: input.subAccountId,
    ...(wantsLeadForm(input.config) && input.formId
      ? { formId: input.formId, formSubmitUrl: `${appUrl}/api/forms/${input.formId}/submit` }
      : {}),
    ...(wantsChatWidget(input.config) ? { widgetScriptUrl: `${appUrl}/widget.js` } : {}),
  };
}

/** Absolute build.settled callback URL, or null when not publicly reachable. */
export function buildSettledCallbackUrl(resolved?: string | null): string | null {
  const appUrl = (resolved ?? process.env.NEXT_PUBLIC_APP_URL ?? "").trim().replace(/\/$/, "");
  if (!/^https:\/\/[^\s/]+$/i.test(appUrl)) return null;
  return `${appUrl}/api/webhooks/gitpage/build-settled`;
}


export async function provisionWebsiteHandoff(
  input: HandoffInput,
): Promise<WebsiteProvisioning> {
  const { subAccountId, siteId, site, config, liveUrl, result } = input;
  const db = getAdminDb();
  const errors: string[] = [];
  // liveUrl is already resolved by settleWebsiteBuild; keep gitpage's reported
  // host too so both entry points load the widget.
  const hostname = hostnameOf(liveUrl);
  const reportedHost = result.pagesUrl ? hostnameOf(result.pagesUrl) : null;
  const premium = result.premium;

  const subSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  const sub = (subSnap.data() ?? {}) as SubAccountDoc;
  const agencyId = (sub.agencyId as string | undefined) ?? site.agencyId;

  const out: WebsiteProvisioning = {
    at: FieldValue.serverTimestamp(),
    hostname,
    formId: site.formId ?? null,
    chatAllowlisted: false,
    chatEnabled: false,
    chatSkippedReason: null,
    kbSeeded: false,
    personaSeeded: false,
    workflowId: null,
    workflowStatus: null,
    workflowChannels: [],
    errors,
  };

  // Auto-filled values track the latest published site until the operator edits
  // them. "Auto" means blank, the stock default, or still equal to what the
  // hand-off seeded last time (or a build KB with no record). Operator wording
  // is never overwritten.
  const profileBefore = await getAgentProfile(subAccountId).catch(() => null);
  const seededBefore = profileBefore?.websiteSeeded ?? null;
  const legacyAuto = !seededBefore && profileBefore?.websiteKbSource === "gitpage-build";
  const isAuto = (current: string | null | undefined, seeded: string | null | undefined, stock?: string) =>
    !current?.trim() || (stock !== undefined && current === stock) || (!!seeded && current === seeded) || legacyAuto;
  const seededNext: NonNullable<AiAgentProfile["websiteSeeded"]> = { ...(seededBefore ?? {}) };

  // Steps 1 + 3: allowlist the hostname, then switch the channel on.
  if (wantsChatWidget(config)) {
    try {
      const existing = await getChannelConfig(subAccountId, "web-chat");
      const webChat = { ...DEFAULT_WEB_CHAT_CONFIG, ...(existing?.webChat ?? {}) };
      const domains = new Set(webChat.allowedDomains.map((d) => d.toLowerCase()));
      if (hostname && !domains.has(hostname)) domains.add(hostname);
      if (reportedHost && !domains.has(reportedHost)) domains.add(reportedHost);
      const persona = premium?.agentPersona ?? null;
      if (persona?.welcomeMessage && isAuto(webChat.welcomeMessage, seededBefore?.welcomeMessage, DEFAULT_WEB_CHAT_CONFIG.welcomeMessage)) {
        webChat.welcomeMessage = persona.welcomeMessage;
        seededNext.welcomeMessage = persona.welcomeMessage;
      }
      if (premium?.theme?.primaryColor && isAuto(webChat.accentColor, seededBefore?.accentColor, DEFAULT_WEB_CHAT_CONFIG.accentColor)) {
        webChat.accentColor = premium.theme.primaryColor;
        seededNext.accentColor = premium.theme.primaryColor;
      }
      webChat.allowedDomains = [...domains];
      out.chatAllowlisted = !!hostname;

      let enable = existing?.enabled === true;
      if (!enable) {
        if (!aiIsConfigured()) {
          out.chatSkippedReason = "OPENROUTER_API_KEY is not set on this deployment — the widget is on the site but the bot stays off until a key is added and Web Chat is enabled.";
        } else if (!aiChannelGateOn(sub, "web-chat")) {
          out.chatSkippedReason = "The agency has locked Web Chat AI for this workspace.";
        } else {
          enable = true;
        }
      }
      await upsertChannelConfig(subAccountId, "web-chat", {
        webChat,
        ...(enable ? { enabled: true } : {}),
      });
      out.chatEnabled = enable;
    } catch (err) {
      errors.push(`web-chat: ${errText(err)}`);
    }
  } else {
    out.chatSkippedReason = "Chat widget not included in this build.";
  }

  // Turn the mic on if the build asked for it and ElevenLabs is ready. Never turns
  // it off: voice is workspace-wide, shared by every site.
  if (
    wantsWebVoice(config) &&
    out.chatEnabled &&
    sub.webVoiceEnabledByAgency === true &&
    sub.webVoiceMeta?.ready === true
  ) {
    try {
      if (sub.webVoiceMeta.enabled === false) {
        const meta = await updateWebVoiceSettings({ subAccountId, patch: { enabled: true } });
        out.voiceEnabled = meta.ready && meta.enabled;
      } else {
        out.voiceEnabled = true;
      }
    } catch (err) {
      errors.push(`web-voice: ${errText(err)}`);
    }
  }

  // Step 2: KB + persona, one write.
  try {
    const profile = profileBefore;
    const persona = premium?.agentPersona ?? null;
    const patch: Partial<AiAgentProfile> = {
      websiteUrl: liveUrl,
    };
    if (premium?.kbText) {
      patch.websiteKb = premium.kbText.slice(0, KB_MAX_CHARS);
      patch.websiteKbFetchedAt = FieldValue.serverTimestamp();
      patch.websiteKbSource = "gitpage-build";
      patch.websiteKbSiteId = siteId;
      out.kbSeeded = true;
    }
    if (persona) {
      if (isAuto(profile?.systemPrompt, seededBefore?.systemPrompt)) {
        patch.systemPrompt = persona.systemPrompt;
        seededNext.systemPrompt = persona.systemPrompt;
        out.personaSeeded = true;
      }
      if (persona.businessName && isAuto(profile?.businessName, seededBefore?.businessName)) {
        patch.businessName = persona.businessName;
        seededNext.businessName = persona.businessName;
      }
      if (!profile && Array.isArray(persona.escalationKeywords) && persona.escalationKeywords.length) {
        patch.escalationKeywords = persona.escalationKeywords;
      }
    }
    if (!profile?.escalationNotifyEmail?.trim()) {
      const email = (config.contact_details ?? "").trim() || sub.accountContact?.email?.trim() || "";
      if (email) patch.escalationNotifyEmail = email;
    }
    patch.websiteSeeded = seededNext;
    await upsertAgentProfile(subAccountId, patch);
  } catch (err) {
    errors.push(`agent profile: ${errText(err)}`);
  }

  // Step 4.
  if (wantsLeadForm(config) && site.formId) {
    try {
      const formId = site.formId;
      const already = await db
        .collection("workflows")
        .where("subAccountId", "==", subAccountId)
        .where("provisionedFrom", "==", WEBSITE_WORKFLOW_SOURCE)
        .get();
      const match = already.docs.find(
        (d) => (d.data() as WorkflowDoc).trigger?.formId === formId,
      );
      if (match) {
        const wf = match.data() as WorkflowDoc;
        out.workflowId = match.id;
        out.workflowStatus = wf.status === "active" ? "active" : "draft";
        out.workflowChannels = Object.values(wf.nodes ?? {}).map((n) => n.type);
      } else {
        const agencySnap = agencyId ? await db.doc(`agencies/${agencyId}`).get() : null;
        const agency = (agencySnap?.data() ?? {}) as AgencyDoc;
        const sharedSmsAllowed = agency.sharedSmsAllowed !== false;
        const smsReady =
          subAccountTwilioIsConfigured(sub.twilioConfig) ||
          (sharedSmsAllowed && smsIsConfigured());
        const emailReady = emailIsConfigured();

        const workflowId = await createWorkflowServerSide({
          subAccountId,
          createdByUid: site.lastBuildByUid ?? "system",
          name: "Website speed-to-lead",
          template: "speed-to-lead",
        });
        const seeded = (await db.doc(`workflows/${workflowId}`).get()).data() as WorkflowDoc;
        const kept: WorkflowNode[] = [];
        for (const id of ["n1", "n2", "n3"]) {
          const node = seeded.nodes[id];
          if (!node) continue;
          if (node.type === "send_sms" && !smsReady) continue;
          if (node.type === "send_email" && !emailReady) continue;
          kept.push({ ...node });
        }
        // Re-link the remaining chain in order.
        const nodes: Record<string, WorkflowNode> = {};
        kept.forEach((node, i) => {
          nodes[node.id] = { ...node, next: kept[i + 1]?.id ?? null };
        });
        const notify = nodes.n3;
        if (notify) {
          notify.config = {
            ...notify.config,
            recipient: sub.accountContact?.email?.trim() ? "account_contact" : "owner",
            subject: `New lead from ${config.heading || "your website"}`,
            body: "{{contact.name}} ({{contact.email}} · {{contact.phone}}) just submitted the website contact form.",
          };
        }
        const channels = kept.map((n) => n.type);
        const customerFacing = channels.some((t) => t === "send_sms" || t === "send_email");
        const status = customerFacing && qstashIsConfigured() ? "active" : "draft";
        await updateWorkflowServerSide({
          subAccountId,
          workflowId,
          patch: {
            trigger: { type: "form.submitted", filters: { all: [] }, formId },
            nodes,
            startNodeId: kept[0]?.id ?? null,
            status,
          },
        });
        await db.doc(`workflows/${workflowId}`).update({
          provisionedFrom: WEBSITE_WORKFLOW_SOURCE,
          provisionedSiteId: siteId,
        });
        out.workflowId = workflowId;
        out.workflowStatus = status;
        out.workflowChannels = channels;
      }
    } catch (err) {
      errors.push(`speed-to-lead: ${errText(err)}`);
    }
  }

  // Step 5.
  if (agencyId) {
    try {
      await sendPushForEvent({
        subAccountId,
        agencyId,
        title: "Website published",
        body: `${site.name || config.heading || "Your site"} is live at ${hostname ?? liveUrl}.`,
        url: `/sa/${subAccountId}/website`,
        tag: `website-${siteId}`,
      });
    } catch (err) {
      errors.push(`push: ${errText(err)}`);
    }
  }

  return out;
}
