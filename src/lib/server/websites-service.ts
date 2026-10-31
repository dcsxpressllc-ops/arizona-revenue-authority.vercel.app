import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminAuth, getAdminDb } from "@/lib/firebase/admin";
import { MAX_WEBSITES_PER_SUBACCOUNT } from "@/lib/website/limits";
import {
  validateWebsiteConfig,
  type ValidationErrors,
} from "@/lib/website/validation";
import { isNicheKey } from "@/lib/website/niches";
import { isTemplateConfig, TEMPLATE_ID_RE } from "@/lib/website/templates";
import {
  GitpageError,
  gitpageIsConfigured,
  hideClientSite,
  submitBuild,
} from "@/lib/gitpage/client";
import {
  markGitpageBuildSucceeded,
  markGitpageKeyInvalid,
} from "@/lib/gitpage/heartbeat";
import { publishCallback, qstashIsConfigured } from "@/lib/automations/qstash";
import type { PollBuildResult, SubmitBuildInput } from "@/lib/gitpage/client";
import {
  buildSettledCallbackUrl,
  resolvedAppUrl,
  resolveLiveUrl,
  ensureWebsiteContactForm,
  leadstackWiringFor,
  provisionWebsiteHandoff,
} from "@/lib/server/website-handoff-service";
import {
  MAX_SITE_PRODUCTS,
  listSellableProducts,
  productsFeedPath,
  toGitpageProducts,
} from "@/lib/server/products-catalog-service";
import {
  blankWebsiteConfig,
  effectiveQuality,
  wantsLeadForm,
  type WebsiteConfig,
  type WebsiteDoc,
} from "@/types/website";

/** First poll delay and cadence in seconds. Premium builds back off after 5 min. */
export const WEBSITE_POLL_INTERVAL_SECONDS = 20;
export const WEBSITE_POLL_BACKOFF_SECONDS = 40;
/** Clamp for the poll cap derived from gitpage's estimate. */
export const WEBSITE_MIN_POLL_ATTEMPTS = 45;
export const WEBSITE_MAX_POLL_ATTEMPTS = 120;

/**
 * Poll ticks before giving up: 1.5x gitpage's estimatedDurationSeconds (300
 * standard, 1200 premium) at the base cadence, clamped to [45, 120]. Standard
 * gets ~15 minutes, premium ~45 once backoff kicks in.
 */
export function pollAttemptCapFor(estimatedDurationSeconds: number | null | undefined): number {
  const est = typeof estimatedDurationSeconds === "number" && estimatedDurationSeconds > 0
    ? estimatedDurationSeconds
    : 300;
  const ticks = Math.ceil((est * 1.5) / WEBSITE_POLL_INTERVAL_SECONDS);
  return Math.min(WEBSITE_MAX_POLL_ATTEMPTS, Math.max(WEBSITE_MIN_POLL_ATTEMPTS, ticks));
}

/** Queued/building this long after the last update means stuck (longer than any
 *  poll window, ~75 min, or QStash missing), so rebuild/reset is allowed. */
const STUCK_BUILD_MS = 90 * 60 * 1000;

/** In flight and not stuck: no rebuild or reset. */
export function buildInFlight(doc: Partial<WebsiteDoc> | null | undefined): boolean {
  if (doc?.status !== "queued" && doc?.status !== "building") return false;
  // Older docs without updatedAt fall back to last build or creation.
  const at = [doc.updatedAt, doc.lastBuildAt, doc.createdAt].find(
    (t) => typeof (t as { toMillis?: unknown } | null)?.toMillis === "function",
  ) as { toMillis: () => number } | undefined;
  if (!at) return false;
  return Date.now() - at.toMillis() < STUCK_BUILD_MS;
}

/** 20s for the first 5 minutes, then 40s. */
export function pollDelayFor(attempts: number): number {
  return attempts >= 15 ? WEBSITE_POLL_BACKOFF_SECONDS : WEBSITE_POLL_INTERVAL_SECONDS;
}


/**
 * Website create + build, shared by the website routes and the AI Suite
 * create_website capability so both hit the same guards (agency gate, site cap,
 * gitpage config, validation, poll scheduling). Callers do auth.
 *
 * Errors map to the routes' JSON shapes or a chat message. `fieldErrors` for
 * validation failures; `gitpageStatus`/`gitpageBody` for gitpage 4xx.
 */
export class WebsiteServiceError extends Error {
  readonly status: number;
  readonly fieldErrors?: ValidationErrors;
  readonly gitpageStatus?: number;
  readonly gitpageBody?: unknown;
  constructor(
    message: string,
    status: number,
    extra?: { fieldErrors?: ValidationErrors; gitpageStatus?: number; gitpageBody?: unknown },
  ) {
    super(message);
    this.name = "WebsiteServiceError";
    this.status = status;
    this.fieldErrors = extra?.fieldErrors;
    this.gitpageStatus = extra?.gitpageStatus;
    this.gitpageBody = extra?.gitpageBody;
  }
}

const GATE_OFF_MESSAGE =
  "The website builder is disabled for this sub-account. Your agency administrator can enable it from Manage in the agency sub-accounts list.";

/** Loads the sub-account and enforces the agency website gate. */
async function requireWebsiteEnabledSub(subAccountId: string): Promise<{
  agencyId: string;
  name: string | undefined;
  data: Record<string, unknown>;
}> {
  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  if (!snap.exists) {
    throw new WebsiteServiceError("Sub-account not found", 404);
  }
  const data = snap.data() as Record<string, unknown>;
  if (data.websiteEnabledByAgency !== true) {
    throw new WebsiteServiceError(GATE_OFF_MESSAGE, 403);
  }
  const agencyId = data.agencyId as string | undefined;
  if (!agencyId) {
    throw new WebsiteServiceError("Sub-account is missing agencyId.", 500);
  }
  return { agencyId, name: data.name as string | undefined, data };
}

/** Blank draft website doc, enforcing the gate and site cap. Returns the id. */
export async function createWebsiteForSubAccount(input: {
  subAccountId: string;
  /** Card label; defaults to "Website N". */
  name?: string;
}): Promise<{ siteId: string; agencyId: string }> {
  const { subAccountId } = input;
  const { agencyId } = await requireWebsiteEnabledSub(subAccountId);

  const db = getAdminDb();
  const col = db.collection(`subAccounts/${subAccountId}/website`);
  const existing = await col.get();
  if (existing.size >= MAX_WEBSITES_PER_SUBACCOUNT) {
    throw new WebsiteServiceError(
      `You can create up to ${MAX_WEBSITES_PER_SUBACCOUNT} websites per sub-account. Remove one to add another.`,
      409,
    );
  }

  const ref = col.doc();
  const now = FieldValue.serverTimestamp();
  const docData: Omit<WebsiteDoc, "createdAt" | "updatedAt" | "lastBuildAt"> & {
    createdAt: FieldValue;
    updatedAt: FieldValue;
    lastBuildAt: null;
  } = {
    id: ref.id,
    agencyId,
    subAccountId,
    name: input.name?.trim() || `Website ${existing.size + 1}`,
    status: "draft",
    gitpageJobId: null,
    liveUrl: null,
    errorMessage: null,
    partialErrors: null,
    pollAttempts: 0,
    lastBuildAt: null,
    lastBuildByUid: null,
    config: blankWebsiteConfig(),
    createdAt: now,
    updatedAt: now,
  };
  await ref.set(docData);

  return { siteId: ref.id, agencyId };
}

/** Normalize an untrusted config in place: system fields, build_type default,
 *  niche check, page selections per build type + niche. */
export function normalizeWebsiteConfig(config: WebsiteConfig): void {
  config.site_type = "LocalSite";
  config.astra_theme = false;

  if (config.build_type !== "vsl") {
    config.build_type = "local";
  }

  // Standard builds aren't offered anymore, so everything builds as premium
  // (including old "standard" drafts). Premium flags are normalised to booleans.
  config.quality = "premium";
  if (config.quality === "premium") {
    config.include_form = config.include_form !== false;
    config.include_chat = config.include_chat !== false;
    config.include_voice = config.include_voice !== false;
    config.concept = typeof config.concept === "string" && config.concept.trim() ? config.concept.trim() : null;
    config.hero_motion = config.hero_motion ?? null;
    config.premium_details = config.premium_details ?? null;
  } else {
    config.include_form = false;
    config.include_chat = false;
    config.include_voice = false;
    config.concept = null;
    config.hero_motion = null;
  }

  // Only touched when present, so configs without it are stored unchanged.
  if (config.product_ids !== undefined) {
    config.product_ids = Array.isArray(config.product_ids)
      ? [
          ...new Set(
            config.product_ids.filter(
              (id): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id),
            ),
          ),
        ].slice(0, MAX_SITE_PRODUCTS)
      : null;
  }

  if (config.niche != null && !isNicheKey(config.niche)) {
    throw new WebsiteServiceError(
      "niche must be one of: home_services, real_estate, gym_fitness, agency_consulting, ai_consulting, ai_automation. Omit for a generic build.",
      400,
    );
  }
  config.niche = isNicheKey(config.niche) ? config.niche : null;

  // Template builds: the template supplies design and pages; business details
  // stay (contact page on).
  if (isTemplateConfig(config)) {
    const id = String(config.template_id).trim();
    if (!TEMPLATE_ID_RE.test(id)) {
      throw new WebsiteServiceError("That template id isn't valid. Pick the template again.", 400);
    }
    config.template_id = id;
    config.template_name =
      typeof config.template_name === "string" && config.template_name.trim()
        ? config.template_name.trim().slice(0, 120)
        : null;
    config.build_type = "local";
    config.niche = null;
    // Title in LeadStack (cards, lead emails); gitpage ignores it.
    config.heading = (config.business_details?.business_name ?? "").trim().slice(0, 80);
    // The template decides whether there's a form and chat widget; if so, gitpage
    // needs this sub-account's wiring to re-point them.
    config.include_form = true;
    config.include_chat = true;
    config.local_page_selections = {
      index: true,
      services: !!config.local_page_selections?.services,
      contact: true,
      privacy: !!config.local_page_selections?.privacy,
      terms: !!config.local_page_selections?.terms,
    };
  } else if (config.template_id !== undefined || config.template_name !== undefined) {
    // Switched away from a template: drop the leftovers.
    config.template_id = null;
    config.template_name = null;
  }

  if (config.build_type === "local") {
    if (!config.local_page_selections) {
      throw new WebsiteServiceError("local_page_selections is required.", 400);
    }
    config.local_page_selections.index = true;

    if (config.niche) {
      // Niche builds always get all five pages; store what gitpage actually builds.
      config.local_page_selections = {
        index: true,
        services: true,
        contact: true,
        privacy: true,
        terms: true,
      };
    } else {
      // Generic local: drop sections that don't apply.
      if (!config.local_page_selections.services) {
        config.services_config = null;
      }
      if (!config.local_page_selections.contact) {
        config.business_details = null;
      }
    }
  } else {
    // VSL is single-page; reset so no stale local-mode selections linger.
    config.local_page_selections = {
      index: true,
      services: false,
      contact: false,
      privacy: false,
      terms: false,
    };
    config.services_config = null;
    config.business_details = null;
  }
}

/** gitpage request fields to wizard field keys (template builds). */
const TEMPLATE_FIELD_KEYS: Record<string, string> = {
  businessName: "business_details.business_name",
  businessEmail: "contact_details",
  businessPhone: "business_details.business_phone",
  businessStreet: "business_details.business_street",
  businessCity: "business_details.business_city",
  businessState: "business_details.business_state",
  businessZip: "business_details.business_zip",
  businessCountry: "business_details.business_country",
  ctaLink: "cta_link",
};

const TEMPLATE_FIELD_LABELS: Record<string, string> = {
  businessName: "Business name",
  businessEmail: "Contact email",
  businessPhone: "Phone",
  businessStreet: "Street",
  businessCity: "City",
  businessState: "State / region",
  businessZip: "Postcode / ZIP",
  businessCountry: "Country",
  ctaLink: "Main button link",
};

/** Template build error with gitpage's field names swapped for wizard labels. */
function templateErrorText(message: string): string {
  return message.replace(/\b(business(?:Name|Email|Phone|Street|City|State|Zip|Country)|ctaLink)\b/g, (name) => TEMPLATE_FIELD_LABELS[name] ?? name);
}

/** gitpage's "Missing business details" as wizard field errors, or null. */
function templateFieldErrors(body: unknown): Record<string, string> | null {
  const missing = (body as { missing?: unknown } | null)?.missing;
  if (!Array.isArray(missing)) return null;
  const errors: Record<string, string> = {};
  for (const name of missing) {
    const key = typeof name === "string" ? TEMPLATE_FIELD_KEYS[name] : undefined;
    if (key) errors[key] = "The template shows this — add this business's own.";
  }
  return Object.keys(errors).length ? errors : null;
}

/** Validate, submit to gitpage, persist queued state and schedule the poll.
 *  Normalizes `config` in place first. */
export async function submitWebsiteBuildForSubAccount(input: {
  subAccountId: string;
  siteId: string;
  config: WebsiteConfig;
  buildByUid: string;
}): Promise<{ formResponseId: string; estimatedDurationSeconds?: number }> {
  const { subAccountId, siteId, config } = input;
  const { name: subAccountName } =
    await requireWebsiteEnabledSub(subAccountId);

  if (!gitpageIsConfigured()) {
    throw new WebsiteServiceError(
      "gitpage is not configured on this deployment (GITPAGE_API_KEY missing).",
      503,
    );
  }

  normalizeWebsiteConfig(config);

  const errors = validateWebsiteConfig(config);
  if (Object.keys(errors).length > 0) {
    throw new WebsiteServiceError("Validation failed.", 400, {
      fieldErrors: errors,
    });
  }

  const db = getAdminDb();
  const docRef = db.doc(`subAccounts/${subAccountId}/website/${siteId}`);
  const snap = await docRef.get();
  const existingDoc = (snap.data() ?? {}) as Partial<WebsiteDoc>;
  // Builds never create sites; createWebsiteForSubAccount does (and enforces the
  // limit).
  if (!snap.exists) {
    throw new WebsiteServiceError("Website not found in this workspace.", 404);
  }
  // One build per site at a time; a second would orphan the first job's site.
  if (buildInFlight(existingDoc)) {
    throw new WebsiteServiceError(
      "That site is building right now — wait for it to finish before building it again.",
      409,
    );
  }

  // The contact form must exist before the request since gitpage bakes its
  // submit URL into the site. Reused across rebuilds and sites.
  let formId: string | null = null;
  if (wantsLeadForm(config)) {
    try {
      formId = await ensureWebsiteContactForm({
        subAccountId,
        createdByUid: input.buildByUid,
        existingFormId: existingDoc.formId ?? null,
      });
    } catch (err) {
      throw new WebsiteServiceError(
        `Could not prepare the website contact form: ${err instanceof Error ? err.message : String(err)}`,
        500,
      );
    }
  }
  const publicAppUrl = await resolvedAppUrl();
  const leadstack: SubmitBuildInput["leadstack"] =
    config.quality === "premium"
      ? leadstackWiringFor({ subAccountId, formId, config, appUrl: publicAppUrl }) ?? undefined
      : undefined;
  if (config.quality === "premium" && !leadstack) {
    console.warn(
      "[website/build] NEXT_PUBLIC_APP_URL is not a public https URL — the premium site will carry no LeadStack form/widget wiring",
    );
  }
  // Sell Online: attach the products only when there is something to sell,
  // so every other build request stays exactly as it was. VSL funnels are a
  // single page, so they never get a shop.
  if (leadstack && config.build_type !== "vsl") {
    try {
      const sub = (await db.doc(`subAccounts/${subAccountId}`).get()).data() ?? {};
      const picked = config.product_ids;
      const sellable = (await listSellableProducts(subAccountId, sub)).filter(
        (p) => !Array.isArray(picked) || picked.includes(p.id),
      );
      if (sellable.length > 0) {
        leadstack.products = await toGitpageProducts(subAccountId, sellable, leadstack.appUrl);
        leadstack.productsFeedUrl = `${leadstack.appUrl}${productsFeedPath(subAccountId)}`;
      }
    } catch (err) {
      // A shop is an extra; never fail the build over it.
      console.warn(`[website/build] products skipped sa=${subAccountId}`, err);
    }
  }
  const callbackUrl = buildSettledCallbackUrl(publicAppUrl) ?? undefined;

  // Give the builder editor access to the new gitpage site (for the GitPage MCP).
  // No email, no invite.
  let editorEmail: string | undefined;
  try {
    const u = await getAdminAuth().getUser(input.buildByUid);
    editorEmail = u.email?.trim().toLowerCase() || undefined;
  } catch {
    editorEmail = undefined;
  }

  // 4xx: show gitpage's error verbatim. 5xx/network: say we couldn't reach it.
  let submission;
  try {
    submission = await submitBuild({
      config,
      subAccountId,
      subAccountName,
      leadstack,
      callbackUrl,
      editorEmail,
    });
  } catch (err) {
    if (err instanceof GitpageError) {
      // Invalid API key: flip the cached status so the UI shows the right CTA.
      if (err.status === 401) {
        await markGitpageKeyInvalid();
      }
      // gitpage lists the template details the build is missing; point the wizard
      // at those fields.
      const fieldErrors = isTemplateConfig(config) ? templateFieldErrors(err.body) : null;
      if (fieldErrors) {
        throw new WebsiteServiceError("This template shows these details, so the new site needs its own — fill in the highlighted fields.", 400, {
          fieldErrors,
          gitpageStatus: err.status,
          gitpageBody: err.body,
        });
      }
      throw new WebsiteServiceError(err.message, err.status, {
        gitpageStatus: err.status,
        gitpageBody: err.body,
      });
    }
    throw new WebsiteServiceError(
      err instanceof Error ? err.message : "Could not reach gitpage.",
      502,
    );
  }

  // A 202 is better evidence than the heartbeat; clear any stale `agency: false`.
  await markGitpageBuildSucceeded();

  const update: Partial<WebsiteDoc> & {
    config: WebsiteConfig;
    updatedAt: FieldValue;
  } = {
    config,
    status: "queued",
    gitpageJobId: submission.formResponseId,
    liveUrl: null,
    errorMessage: null,
    partialErrors: null,
    pollAttempts: 0,
    lastBuildAt: FieldValue.serverTimestamp() as unknown as null,
    lastBuildByUid: input.buildByUid,
    updatedAt: FieldValue.serverTimestamp(),
    quality: config.quality ?? "premium",
    formId,
    estimatedDurationSeconds: submission.estimatedDurationSeconds ?? null,
    statusPhase: null,
    conceptName: null,
    provisioning: null,
    gitpagePageId: null,
    // Hidden in gitpage once the new site publishes.
    replacesGitpagePageId: existingDoc.gitpagePageId ?? existingDoc.replacesGitpagePageId ?? null,
    editorEmail: editorEmail ?? null,
    // A rebuilt import is a LeadStack build from now on.
    importedFrom: null,
  };

  await docRef.set(update, { merge: true });

  // Without QStash the doc just stays "queued"; don't fail the request.
  if (qstashIsConfigured()) {
    await publishCallback({
      pathname: `/api/sub-accounts/${subAccountId}/website/${siteId}/poll`,
      body: {
        subAccountId,
        siteId,
        formResponseId: submission.formResponseId,
      },
      delaySeconds: WEBSITE_POLL_INTERVAL_SECONDS,
      deduplicationId: `website_${subAccountId}_${siteId}_${submission.formResponseId}_0`,
    });
  } else {
    console.warn(
      "[website/build] QStash not configured — status will sit at queued",
    );
  }

  return {
    formResponseId: submission.formResponseId,
    estimatedDurationSeconds: submission.estimatedDurationSeconds,
  };
}

/**
 * Settle a terminal build. Shared by the poll tick and the build.settled
 * callback so both write the same state and run the same hand-off. Callers only
 * call it while the doc is queued/building for this job; the hand-off tolerates
 * re-runs.
 */
export async function settleWebsiteBuild(input: {
  subAccountId: string;
  siteId: string;
  site: WebsiteDoc;
  result: PollBuildResult;
  /** 0 for the callback path. */
  attempts: number;
}): Promise<"ready" | "failed"> {
  const { subAccountId, siteId, site, result } = input;
  const docRef = getAdminDb().doc(`subAccounts/${subAccountId}/website/${siteId}`);

  if (result.status !== "Published") {
    await docRef.update({
      status: "failed",
      errorMessage: isTemplateConfig(site.config)
        ? templateErrorText(result.error ?? "gitpage build failed without details.")
        : result.error ?? "gitpage build failed without details.",
      statusPhase: result.premium?.failedStage ?? result.statusPhase ?? null,
      pollAttempts: input.attempts,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return "failed";
  }

  // GitLab path URLs 308 to the unique domain; store what visitors land on.
  const liveUrl = result.pagesUrl ? await resolveLiveUrl(result.pagesUrl) : null;
  await docRef.update({
    status: "ready",
    liveUrl,
    errorMessage: null,
    partialErrors: result.partialErrors,
    statusPhase: "completed",
    conceptName: result.premium?.theme?.conceptName ?? null,
    ...(result.pageId ? { gitpagePageId: result.pageId, replacesGitpagePageId: null } : {}),
    pollAttempts: input.attempts,
    updatedAt: FieldValue.serverTimestamp(),
  });

  // Hide the replaced gitpage site (still live, unhideable) so gitpage's list
  // matches LeadStack. Templates and sites with a custom domain stay visible.
  // Never fails the publish.
  const replaced = site.replacesGitpagePageId;
  if (replaced && result.pageId && replaced !== result.pageId) {
    await hideClientSite(replaced, subAccountId, "replaced").catch((err) =>
      console.error("[website/settle] could not hide the replaced site in gitpage:", err),
    );
  }

  // PageSpeed once Pages has warmed up.
  if (liveUrl && qstashIsConfigured()) {
    await publishCallback({
      pathname: `/api/sub-accounts/${subAccountId}/website/${siteId}/pagespeed`,
      body: { subAccountId, siteId },
      delaySeconds: 120,
      deduplicationId: `pagespeed_${subAccountId}_${siteId}_${site.gitpageJobId ?? "x"}`,
    }).catch(() => null);
  }

  // Hand-off never fails the publish. Template builds follow the template's own
  // quality; a standard template has no chat wiring to hand over.
  const quality = site.quality ?? effectiveQuality(site.config);
  const standardTemplate = isTemplateConfig(site.config) && !result.premium;
  if (quality === "premium" && liveUrl && !standardTemplate) {
    try {
      const provisioning = await provisionWebsiteHandoff({
        subAccountId,
        siteId,
        site,
        config: { ...blankWebsiteConfig(), ...(site.config ?? {}) },
        liveUrl,
        result,
      });
      await docRef.update({ provisioning, updatedAt: FieldValue.serverTimestamp() });
    } catch (err) {
      console.error("[website/settle] hand-off threw", err);
      await docRef.update({
        provisioning: {
          at: FieldValue.serverTimestamp(),
          hostname: null,
          formId: site.formId ?? null,
          chatAllowlisted: false,
          chatEnabled: false,
          chatSkippedReason: null,
          kbSeeded: false,
          personaSeeded: false,
          workflowId: null,
          workflowStatus: null,
          workflowChannels: [],
          errors: [err instanceof Error ? err.message : String(err)],
        },
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
  }
  return "ready";
}

/**
 * Point a built site's CTA at a new URL and rebuild. The site config holds no
 * form reference, so linking a form means setting `cta_link` to its public URL
 * (or a booking page's). Goes through every guard in
 * submitWebsiteBuildForSubAccount, including the 30/hour rate limit.
 */
export async function updateWebsiteCtaAndRebuild(input: {
  subAccountId: string;
  siteId: string;
  ctaLink: string;
  buildByUid: string;
}): Promise<{
  formResponseId: string;
  siteName: string;
  previousCtaLink: string;
}> {
  const { subAccountId, siteId } = input;
  const ctaLink = input.ctaLink.trim();
  if (!/^https?:\/\/\S+$/i.test(ctaLink)) {
    throw new WebsiteServiceError(
      "The call-to-action link must be a full http(s) URL.",
      400,
    );
  }
  const docRef = getAdminDb().doc(
    `subAccounts/${subAccountId}/website/${siteId}`,
  );
  const snap = await docRef.get();
  if (!snap.exists || snap.data()?.subAccountId !== subAccountId) {
    throw new WebsiteServiceError("Website not found in this workspace.", 404);
  }
  const doc = snap.data() as WebsiteDoc;
  if (buildInFlight(doc)) {
    throw new WebsiteServiceError(
      "That site is building right now — wait for it to finish before changing the call-to-action.",
      409,
    );
  }
  const config: WebsiteConfig = {
    ...blankWebsiteConfig(),
    ...(doc.config ?? {}),
  };
  // A gitpage-made copy has no LeadStack build behind it; rebuilding would wipe
  // changes made since.
  if (doc.importedFrom === "gitpage") {
    throw new WebsiteServiceError(
      "This site was copied in gitpage: rebuilding it would replace it with a new build and lose its edits. Change the link in the site editor instead.",
      409,
    );
  }
  // Template sites take their button from the template; rebuilding just copies it
  // again.
  if (isTemplateConfig(config)) {
    throw new WebsiteServiceError(
      "This site was built from an Agency template: rebuilding it would copy the template again and lose edits made since. Change the link in the site editor instead.",
      409,
    );
  }
  const previousCtaLink = config.cta_link ?? "";
  config.cta_link = ctaLink;

  const submission = await submitWebsiteBuildForSubAccount({
    subAccountId,
    siteId,
    config,
    buildByUid: input.buildByUid,
  });
  const siteName =
    doc.name || config.heading || "Untitled site";
  return { formResponseId: submission.formResponseId, siteName, previousCtaLink };
}
