import "server-only";

import {
  effectiveQuality,
  wantsChatWidget,
  wantsLeadForm,
  type WebsiteConfig,
} from "@/types/website";
import { isNicheKey, NICHE_FORCED_PAGES } from "@/lib/website/niches";
import { isTemplateConfig } from "@/lib/website/templates";
import {
  premiumDetailsPayload,
  premiumModeFor,
} from "@/lib/website/premium";

/**
 * Claude tier forced for premium builds, so quality doesn't depend on the
 * agency's gitpage tier setting (Haiku by default). The agency's gitpage
 * account still needs a Claude/OpenRouter key.
 */
export const PREMIUM_CLAUDE_MODEL = "opus-5.5";

/**
 * gitpage.site client.
 *   submitBuild -> POST /api/v1/generate-site (buildType "local" | "vsl")
 *   pollBuild   -> GET  /api/v1/page-status?formResponseId=...
 *
 * Agency-level API key as a Bearer token. GITPAGE_API_URL overrides the base
 * URL for local mocking. The /api/v1 contract is frozen; breaking changes go
 * to /api/v2. Throws when env isn't set; callers map that to a 503.
 */

const DEFAULT_BASE_URL = "https://www.gitpage.site";

function getBaseUrl(): string {
  return (
    process.env.GITPAGE_API_URL?.replace(/\/$/, "") ?? DEFAULT_BASE_URL
  );
}

function getApiKey(): string {
  const key = process.env.GITPAGE_API_KEY;
  if (!key) {
    throw new Error(
      "GITPAGE_API_KEY is not set. Add it to .env.local + Vercel env vars.",
    );
  }
  return key;
}

export function gitpageIsConfigured(): boolean {
  return !!process.env.GITPAGE_API_KEY;
}

export interface SubmitBuildInput {
  config: WebsiteConfig;
  subAccountId: string;
  /** Shown in gitpage's reporting. */
  subAccountName?: string;
  /** gitpage POSTs `build.settled` here when the build finishes. */
  callbackUrl?: string;
  /** The user who started the build. Invited as an "editor" on the new site (content + publish, no settings). gitpage skips it for the owner. */
  editorEmail?: string;
  /**
   * Premium only. Endpoints baked into the site so the form posts to this
   * sub-account and the chat widget loads for it. Must be https under `appUrl`;
   * gitpage validates.
   */
  leadstack?: {
    appUrl: string;
    subAccountId: string;
    formId?: string;
    formSubmitUrl?: string;
    widgetScriptUrl?: string;
    /** Sell Online: products for the Shop pages. Sent only when non-empty. */
    products?: GitpageProduct[];
    /** Public feed gitpage re-reads for resyncs and the MCP. */
    productsFeedUrl?: string;
  };
}

/** One sellable product in the shape gitpage accepts on a build request. */
export interface GitpageProduct {
  id: string;
  slug: string;
  name: string;
  description: string;
  priceCents: number;
  /** ISO 4217, lowercase. */
  currency: string;
  images: { url: string; alt: string; width?: number; height?: number }[];
  kind: "service" | "course" | "download";
  buyUrl: string;
  version: number;
}

/** Spread into a `leadstack` payload block; absent when there's nothing to sell. */
function productsPart(ls: NonNullable<SubmitBuildInput["leadstack"]>) {
  return ls.products?.length
    ? {
        products: ls.products,
        ...(ls.productsFeedUrl ? { productsFeedUrl: ls.productsFeedUrl } : {}),
      }
    : {};
}

export interface SubmitBuildResult {
  formResponseId: string;
  pollUrl: string;
  pollIntervalSeconds: number;
  estimatedDurationSeconds: number;
}

export async function submitBuild(
  input: SubmitBuildInput,
): Promise<SubmitBuildResult> {
  const url = `${getBaseUrl()}/api/v1/generate-site`;
  const payload = configToGitpagePayload(input);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    // gitpage always returns JSON on the documented codes; if not, fall through.
  }

  if (!res.ok) {
    const baseMessage =
      typeof body.message === "string"
        ? body.message
        : typeof body.error === "string"
          ? body.error
          : `gitpage POST failed: ${res.status}`;
    // Validation failures may carry `details: string[]`; show the first.
    const detail = Array.isArray(body.details)
      ? body.details.find((d) => typeof d === "string")
      : typeof body.details === "string"
        ? body.details
        : null;
    const message = detail ? `${baseMessage} — ${detail}` : baseMessage;
    throw new GitpageError(message, res.status, body);
  }

  if (
    typeof body.formResponseId !== "string" ||
    typeof body.pollUrl !== "string"
  ) {
    throw new GitpageError(
      "gitpage returned 2xx but no formResponseId/pollUrl",
      res.status,
      body,
    );
  }

  return {
    formResponseId: body.formResponseId,
    pollUrl: body.pollUrl,
    pollIntervalSeconds:
      typeof body.pollIntervalSeconds === "number"
        ? body.pollIntervalSeconds
        : 20,
    estimatedDurationSeconds:
      typeof body.estimatedDurationSeconds === "number"
        ? body.estimatedDurationSeconds
        : 300,
  };
}

export type GitpageStatus =
  | "processing"
  | "recovering"
  | "Published"
  | "failed";

export interface PollBuildResult {
  status: GitpageStatus;
  /** e.g. "generating" / "deploying". */
  statusPhase: string | null;
  /** Only set when status === "Published". */
  pagesUrl: string | null;
  repoUrl: string | null;
  error: string | null;
  /** Per-page warnings on an otherwise successful build (e.g. blog failed, home ok). */
  partialErrors: string[] | null;
  /** Caller stops polling. */
  isTerminal: boolean;
  /** ISO timestamp from gitpage. */
  updatedAt: string | null;
  /** Null on standard builds. */
  premium: GitpagePremiumStatus | null;
  /** What the GitPage MCP tools call `pageId`. */
  pageId: string | null;
}

/** Chat persona gitpage derives from the brief (premium). */
export interface GitpageAgentPersona {
  systemPrompt: string;
  businessName: string;
  hoursStart: number;
  hoursEnd: number;
  escalationKeywords: string[];
  welcomeMessage: string;
}

export interface GitpageTheme {
  primaryColor: string;
  accentInk?: string;
  surface?: string;
  ink?: string;
  mode?: "light" | "dark";
  typeSystem?: string;
  archetype?: string;
  concept?: string;
  conceptName?: string;
}

export interface GitpagePremiumStatus {
  quality: "standard" | "premium";
  concept: string | null;
  estimatedDurationSeconds: number | null;
  failedStage: string | null;
  imageProvider: string | null;
  imageCount: number | null;
  briefSource: string | null;
  /** Hand-off artefacts, only once Published. */
  kbText: string | null;
  agentPersona: GitpageAgentPersona | null;
  theme: GitpageTheme | null;
}

function readPremium(body: Record<string, unknown>): GitpagePremiumStatus | null {
  if (body.quality !== "premium") return null;
  const persona = body.agentPersona as Partial<GitpageAgentPersona> | undefined;
  const theme = body.theme as Partial<GitpageTheme> | undefined;
  return {
    quality: "premium",
    concept: typeof body.concept === "string" ? body.concept : null,
    estimatedDurationSeconds:
      typeof body.estimatedDurationSeconds === "number" ? body.estimatedDurationSeconds : null,
    failedStage: typeof body.failedStage === "string" ? body.failedStage : null,
    imageProvider: typeof body.imageProvider === "string" ? body.imageProvider : null,
    imageCount: typeof body.imageCount === "number" ? body.imageCount : null,
    briefSource: typeof body.briefSource === "string" ? body.briefSource : null,
    kbText: typeof body.kbText === "string" && body.kbText.trim() ? body.kbText : null,
    agentPersona:
      persona && typeof persona.systemPrompt === "string" && persona.systemPrompt.trim()
        ? {
            systemPrompt: persona.systemPrompt,
            businessName: typeof persona.businessName === "string" ? persona.businessName : "",
            hoursStart: typeof persona.hoursStart === "number" ? persona.hoursStart : 0,
            hoursEnd: typeof persona.hoursEnd === "number" ? persona.hoursEnd : 0,
            escalationKeywords: Array.isArray(persona.escalationKeywords)
              ? persona.escalationKeywords.filter((k): k is string => typeof k === "string")
              : [],
            welcomeMessage:
              typeof persona.welcomeMessage === "string" ? persona.welcomeMessage : "",
          }
        : null,
    theme:
      theme && typeof theme.primaryColor === "string"
        ? {
            primaryColor: theme.primaryColor,
            ...(typeof theme.accentInk === "string" && { accentInk: theme.accentInk }),
            ...(typeof theme.surface === "string" && { surface: theme.surface }),
            ...(typeof theme.ink === "string" && { ink: theme.ink }),
            ...((theme.mode === "light" || theme.mode === "dark") && { mode: theme.mode }),
            ...(typeof theme.typeSystem === "string" && { typeSystem: theme.typeSystem }),
            ...(typeof theme.archetype === "string" && { archetype: theme.archetype }),
            ...(typeof theme.concept === "string" && { concept: theme.concept }),
            ...(typeof theme.conceptName === "string" && { conceptName: theme.conceptName }),
          }
        : null,
  };
}

/** Normalises a `build.settled` callback into pollBuild's shape so one settle handler serves both. */
export function settledPayloadToPollResult(
  body: Record<string, unknown>,
): PollBuildResult {
  return normalisePollBody(body);
}

export async function pollBuild(
  formResponseId: string,
): Promise<PollBuildResult> {
  const url = `${getBaseUrl()}/api/v1/page-status?formResponseId=${encodeURIComponent(formResponseId)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${getApiKey()}` },
  });

  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    // ignore, the fallthrough handles it
  }

  if (!res.ok) {
    const message =
      typeof body.message === "string"
        ? body.message
        : typeof body.error === "string"
          ? body.error
          : `gitpage GET failed: ${res.status}`;
    throw new GitpageError(message, res.status, body);
  }

  return normalisePollBody(body);
}

export interface ProductImageJob {
  jobId: string;
  status: "pending" | "done" | "failed";
  /** Temporary URL; download it into our own storage. */
  imageUrl: string | null;
  error: string | null;
}

async function gitpageJson(
  path: string,
  init: RequestInit = {},
): Promise<Record<string, unknown>> {
  const res = await fetch(`${getBaseUrl()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    // Non-JSON error pages fall through to the status message.
  }
  if (!res.ok) {
    const message =
      typeof body.message === "string"
        ? body.message
        : typeof body.error === "string"
          ? body.error
          : `gitpage request failed: ${res.status}`;
    throw new GitpageError(message, res.status, body);
  }
  return body;
}

/** Start an AI product image (gitpage runs it on the agency's Higgsfield keys). */
export async function requestProductImage(input: {
  subAccountId: string;
  productId: string;
  name: string;
  description: string;
  kind: "service" | "course" | "download";
}): Promise<{ jobId: string }> {
  const body = await gitpageJson("/api/v1/images/generate", {
    method: "POST",
    body: JSON.stringify({ ...input, aspect: "1:1" }),
  });
  if (typeof body.jobId !== "string") {
    throw new GitpageError("gitpage returned no image job id", 502, body);
  }
  return { jobId: body.jobId };
}

export async function getProductImageJob(jobId: string): Promise<ProductImageJob> {
  const body = await gitpageJson(`/api/v1/images/${encodeURIComponent(jobId)}`);
  const status =
    body.status === "done" || body.status === "failed" ? body.status : "pending";
  const first = Array.isArray(body.images)
    ? (body.images[0] as { url?: unknown } | undefined)
    : undefined;
  return {
    jobId,
    status,
    imageUrl: typeof first?.url === "string" ? first.url : null,
    error: typeof body.error === "string" ? body.error : null,
  };
}

function normalisePollBody(body: Record<string, unknown>): PollBuildResult {
  const rawStatus = (body.status as string) ?? "processing";
  const statusPhase =
    typeof body.statusPhase === "string" ? body.statusPhase : null;
  const pagesUrl = typeof body.pagesUrl === "string" ? body.pagesUrl : null;
  const repoUrl = typeof body.repoUrl === "string" ? body.repoUrl : null;
  const error = typeof body.error === "string" ? body.error : null;
  const updatedAt =
    typeof body.updatedAt === "string" ? body.updatedAt : null;
  const partialErrors = Array.isArray(body.partialErrors)
    ? body.partialErrors.filter((v): v is string => typeof v === "string")
    : null;

  // Per gitpage's guidance: anything starting "Published" is success (incl. the
  // old "Published (Unenhanced)"), any-case "failed" is failure, everything else
  // ("processing", "recovering") is in flight.
  const status: GitpageStatus = rawStatus.startsWith("Published")
    ? "Published"
    : rawStatus.toLowerCase() === "failed"
      ? "failed"
      : rawStatus === "recovering"
        ? "recovering"
        : "processing";

  const isTerminal = status === "Published" || status === "failed";

  return {
    status,
    statusPhase,
    pagesUrl,
    repoUrl,
    error,
    partialErrors: partialErrors && partialErrors.length > 0 ? partialErrors : null,
    isTerminal,
    updatedAt,
    premium: readPremium(body),
    pageId: typeof body.pageId === "string" && body.pageId ? body.pageId : null,
  };
}

// Premium concept "pitch cards" (three per niche)

export interface GitpageConceptCard {
  id: string;
  /** Niche key, or "generic". */
  niche: string;
  name: string;
  /** Picker card copy. */
  pitch: string;
  fit: string;
  archetype: string;
  typeSystem: string;
  defaultMode: "light" | "dark";
  modes: string[];
  /** Accent hex per mode, e.g. { light: "#B13F2B", dark: "#F2C14E" }. */
  accents: Record<string, string>;
  heroMotion: string;
}

/** GET /api/v1/concepts?niche=... (gitpage caches 5 min). null = generic concepts. */
export async function fetchConcepts(
  niche: string | null,
): Promise<GitpageConceptCard[]> {
  const url = `${getBaseUrl()}/api/v1/concepts${niche ? `?niche=${encodeURIComponent(niche)}` : ""}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${getApiKey()}` },
    next: { revalidate: 300 },
  } as RequestInit);
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    // fallthrough
  }
  if (!res.ok) {
    const message =
      typeof body.message === "string"
        ? body.message
        : typeof body.error === "string"
          ? body.error
          : `gitpage GET failed: ${res.status}`;
    throw new GitpageError(message, res.status, body);
  }
  const list = Array.isArray(body.concepts) ? body.concepts : [];
  return list
    .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
    .filter((c) => typeof c.id === "string" && typeof c.name === "string")
    .map((c) => ({
      id: c.id as string,
      niche: typeof c.niche === "string" ? c.niche : "generic",
      name: c.name as string,
      pitch: typeof c.pitch === "string" ? c.pitch : "",
      fit: typeof c.fit === "string" ? c.fit : "",
      archetype: typeof c.archetype === "string" ? c.archetype : "",
      typeSystem: typeof c.typeSystem === "string" ? c.typeSystem : "",
      defaultMode: c.defaultMode === "dark" ? "dark" : "light",
      modes: Array.isArray(c.modes) ? c.modes.filter((m): m is string => typeof m === "string") : [],
      accents:
        c.accents && typeof c.accents === "object"
          ? Object.fromEntries(
              Object.entries(c.accents as Record<string, unknown>).filter(
                (e): e is [string, string] => typeof e[1] === "string",
              ),
            )
          : {},
      heroMotion: typeof c.heroMotion === "string" ? c.heroMotion : "still",
    }));
}

// The agency's saved templates (gitpage My Sites -> "Save as template")

export interface GitpageTemplate {
  templateId: string;
  name: string;
  /** null = suits any niche. */
  niche: string | null;
  previewUrl: string | null;
  quality: "premium" | "standard";
  savedAt: string | null;
  updatedAt: string | null;
  /** "agency": offered to every client; "client": only that sub-account sees it. */
  scope: "agency" | "client";
}

/**
 * GET /api/v1/templates: agency templates, plus the client's own when
 * `subAccountId` is given. 404 (templates off, or an older gitpage without the
 * route) means "not available", not an error. `enabled` with an empty list
 * means available, none saved yet.
 */
export async function fetchTemplates(
  subAccountId?: string,
): Promise<{ enabled: boolean; templates: GitpageTemplate[]; clientTemplates: boolean }> {
  const query = subAccountId ? `?subAccountId=${encodeURIComponent(subAccountId)}` : "";
  const res = await fetch(`${getBaseUrl()}/api/v1/templates${query}`, {
    headers: { Authorization: `Bearer ${getApiKey()}` },
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  if (res.status === 404) return { enabled: false, templates: [], clientTemplates: false };
  const body = await readTemplatesBody(res, "GET");
  const list = Array.isArray(body.templates) ? body.templates : [];
  return {
    enabled: true,
    templates: list.map(toTemplate).filter((t): t is GitpageTemplate => !!t),
    // Older gitpage doesn't support client templates (it would save agency-wide).
    clientTemplates: body.clientTemplates === true,
  };
}

/**
 * POST /api/v1/templates: save a gitpage site as a template, or rename one.
 * `client` acts as that client (can't touch agency templates). `scope` is
 * owner-only; omitted, a rename keeps the scope and a new template is agency-wide.
 */
export async function saveTemplate(
  pageId: string,
  name: string,
  opts: { client?: string; scope?: "agency" | "client" } = {},
): Promise<GitpageTemplate | null> {
  const payload: Record<string, unknown> = { pageId, name };
  if (opts.client) Object.assign(payload, { actingAs: "client", subAccountId: opts.client });
  else if (opts.scope) payload.scope = opts.scope;
  const res = await fetch(`${getBaseUrl()}/api/v1/templates`, {
    method: "POST",
    headers: { Authorization: `Bearer ${getApiKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 404) {
    const body = await res.json().catch(() => ({}) as Record<string, unknown>);
    throw new GitpageError(
      typeof (body as { error?: unknown }).error === "string" && (body as { error: string }).error !== "Not found"
        ? (body as { error: string }).error
        : "Agency templates aren't switched on for this gitpage account.",
      404,
      body,
    );
  }
  const body = await readTemplatesBody(res, "POST");
  return toTemplate(body.template);
}

/** DELETE /api/v1/templates. With `client`, only that client's own templates. */
export async function removeTemplate(pageId: string, client?: string): Promise<void> {
  const res = await fetch(`${getBaseUrl()}/api/v1/templates`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${getApiKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify(client ? { pageId, actingAs: "client", subAccountId: client } : { pageId }),
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });
  await readTemplatesBody(res, "DELETE");
}

async function readTemplatesBody(res: Response, method: string): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    // fallthrough
  }
  if (!res.ok) {
    const message =
      typeof body.message === "string"
        ? body.message
        : typeof body.error === "string"
          ? body.error
          : `gitpage ${method} failed: ${res.status}`;
    throw new GitpageError(message, res.status, body);
  }
  return body;
}

function toTemplate(t: unknown): GitpageTemplate | null {
  if (!t || typeof t !== "object") return null;
  const r = t as Record<string, unknown>;
  if (typeof r.templateId !== "string" || typeof r.name !== "string") return null;
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  return {
    templateId: r.templateId,
    name: r.name,
    niche: str(r.niche),
    previewUrl: str(r.previewUrl),
    quality: r.quality === "premium" ? "premium" : "standard",
    savedAt: str(r.savedAt),
    updatedAt: str(r.updatedAt),
    scope: r.scope === "client" ? "client" : "agency",
  };
}

// Sites gitpage holds for one sub-account, incl. copies made with Duplicate

export interface GitpageClientSite {
  pageId: string;
  repoName: string | null;
  status: string | null;
  liveUrl: string | null;
  customDomain: string | null;
  quality: "premium" | "standard";
  /** "duplicate": made in gitpage; "build": a LeadStack build. */
  origin: "duplicate" | "build";
  duplicatedFrom: string | null;
  createdAt: string | null;
}

/** GET /api/v1/sites?subAccountId=. 404 on older gitpage means none. */
export async function fetchClientSites(subAccountId: string): Promise<GitpageClientSite[]> {
  const res = await fetch(`${getBaseUrl()}/api/v1/sites?subAccountId=${encodeURIComponent(subAccountId)}`, {
    headers: { Authorization: `Bearer ${getApiKey()}` },
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  if (res.status === 404) return [];
  const body = await readTemplatesBody(res, "GET sites");
  const list = Array.isArray(body.sites) ? body.sites : [];
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  return list.flatMap((s: unknown): GitpageClientSite[] => {
    if (!s || typeof s !== "object") return [];
    const r = s as Record<string, unknown>;
    if (typeof r.pageId !== "string" || !r.pageId) return [];
    return [{
      pageId: r.pageId,
      repoName: str(r.repoName),
      status: str(r.status),
      liveUrl: str(r.liveUrl),
      customDomain: str(r.customDomain),
      quality: r.quality === "premium" ? "premium" : "standard",
      origin: r.origin === "duplicate" ? "duplicate" : "build",
      duplicatedFrom: str(r.duplicatedFrom),
      createdAt: str(r.createdAt),
    }];
  });
}

/** POST /api/v1/sites: sync the client name gitpage groups sites by. Callers ignore 400/404 from older gitpage. */
export async function renameClientSites(subAccountId: string, subAccountName: string): Promise<void> {
  const res = await fetch(`${getBaseUrl()}/api/v1/sites`, {
    method: "POST",
    headers: { Authorization: `Bearer ${getApiKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "rename", subAccountId, subAccountName }),
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  await readTemplatesBody(res, "rename client");
}

/** POST /api/v1/sites: hide a site ("Delete website"). It stays live and can be unhidden in gitpage. */
export async function hideClientSite(
  pageId: string,
  subAccountId: string,
  /** A rebuild replaced it; gitpage then keeps templates and sites with a domain. */
  reason?: "replaced",
): Promise<void> {
  const res = await fetch(`${getBaseUrl()}/api/v1/sites`, {
    method: "POST",
    headers: { Authorization: `Bearer ${getApiKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "hide", pageId, subAccountId, ...(reason && { reason }) }),
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });
  await readTemplatesBody(res, "hide site");
}

export class GitpageError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(message: string, status: number, body: Record<string, unknown>) {
    super(message);
    this.name = "GitpageError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Template build payload (`buildType: "template"`). The template supplies
 * design, pages and copy. Form/widget wiring is always sent when present:
 * gitpage refuses the build if it can't re-point the template's form or widget.
 */
function templatePayload(input: SubmitBuildInput): Record<string, unknown> {
  const c = input.config;
  const b = c.business_details;
  const t = (v: string | undefined | null) => (typeof v === "string" ? v.trim() : "");
  const ls = input.leadstack;
  return {
    buildType: "template",
    templateId: c.template_id,
    subAccountId: input.subAccountId,
    ...(input.subAccountName ? { subAccountName: input.subAccountName } : {}),
    ...(input.callbackUrl ? { callbackUrl: input.callbackUrl } : {}),
    ...(input.editorEmail ? { editorEmail: input.editorEmail } : {}),
    businessName: t(b?.business_name),
    businessEmail: t(c.contact_details) || t(b?.business_email),
    ...(t(b?.business_phone) && { businessPhone: t(b?.business_phone) }),
    ...(t(b?.business_street) && { businessStreet: t(b?.business_street) }),
    ...(t(b?.business_city) && { businessCity: t(b?.business_city) }),
    ...(t(b?.business_state) && { businessState: t(b?.business_state) }),
    ...(t(b?.business_zip) && { businessZip: t(b?.business_zip) }),
    ...(t(b?.business_country) && { businessCountry: t(b?.business_country) }),
    // Replaces the template's main/booking button link.
    ...(t(c.cta_link) && { ctaLink: t(c.cta_link) }),
    ...(ls
      ? {
          leadstack: {
            appUrl: ls.appUrl,
            subAccountId: ls.subAccountId,
            ...(ls.formId && ls.formSubmitUrl ? { formId: ls.formId, formSubmitUrl: ls.formSubmitUrl } : {}),
            ...(ls.widgetScriptUrl ? { widgetScriptUrl: ls.widgetScriptUrl } : {}),
            ...productsPart(ls),
          },
        }
      : {}),
  };
}

/**
 * Maps snake_case WebsiteConfig to gitpage's camelCase payload.
 * "local": multi-page site, pages + optional services/business flattened in.
 * "vsl": single page, videoLink required, no pages/business/services/theme.
 * Missing build_type means "local" (older docs).
 */
function configToGitpagePayload(input: SubmitBuildInput) {
  const c = input.config;
  if (isTemplateConfig(c)) return templatePayload(input);
  const buildType = c.build_type ?? "local";
  // Optional niche swaps in gitpage's design system and section structure. local
  // niche builds get a fixed page set (no blog); vsl gets privacy + terms
  // automatically. Mirrored here to match gitpage's validation.
  const niche = isNicheKey(c.niche) ? c.niche : null;

  const payload: Record<string, unknown> = {
    buildType,
    ...(niche ? { niche } : {}),
    subAccountId: input.subAccountId,
    ...(input.subAccountName ? { subAccountName: input.subAccountName } : {}),
    ...(input.callbackUrl ? { callbackUrl: input.callbackUrl } : {}),
    ...(input.editorEmail ? { editorEmail: input.editorEmail } : {}),

    heading: c.heading,
    heroStatement: c.hero_statement,
    features: c.features,
    benefits: c.benefits,
    contactEmail: c.contact_details,
    ctaLink: c.cta_link,

    language: c.language,
    colorScheme: c.color_scheme,
    includeFaq: c.include_faq,

    designColorPalette: c.design_color_palette,
    designTypography: c.design_typography,
    designLayout: c.design_layout,
    designComponents: c.design_components,
    designInteractions: c.design_interactions,
    designButtons: c.design_buttons,
    designContactForm: c.design_contact_form,
    designIcons: c.design_icons,
  };

  if (c.design_color_palette === "Custom" && c.custom_colors.trim()) {
    payload.customColors = c.custom_colors.trim();
  }

  // Premium: quality, forced Opus tier, premium block and wiring. Standard
  // builds send none of this so their request is unchanged.
  if (effectiveQuality(c) === "premium") {
    payload.quality = "premium";
    payload.claudeModel = PREMIUM_CLAUDE_MODEL;
    payload.premium = {
      ...(c.concept && { concept: c.concept }),
      mode: premiumModeFor(c),
      ...(c.hero_motion && { heroMotion: c.hero_motion }),
      ...premiumDetailsPayload(c.premium_details),
    };
    const notes = c.premium_details?.reference_notes?.trim();
    if (notes) payload.referenceNotes = notes;
    if (input.leadstack) {
      const ls = input.leadstack;
      payload.leadstack = {
        appUrl: ls.appUrl,
        subAccountId: ls.subAccountId,
        ...(wantsLeadForm(c) && ls.formId && ls.formSubmitUrl
          ? { formId: ls.formId, formSubmitUrl: ls.formSubmitUrl }
          : {}),
        ...(wantsChatWidget(c) && ls.widgetScriptUrl
          ? { widgetScriptUrl: ls.widgetScriptUrl }
          : {}),
        ...productsPart(ls),
      };
    }
  } else {
    payload.quality = "standard";
  }

  if (buildType === "vsl") {
    payload.videoLink = c.video_link.trim();
    // VSL has no pages array; gitpage adds privacy/terms itself.
    return payload;
  }

  payload.astraTheme = c.astra_theme;

  // Niche locks pages to [index, services, contact, privacy, terms]. Generic
  // builds send the user's picks, plus privacy.html if opted in.
  if (niche) {
    payload.pages = [...NICHE_FORCED_PAGES];
  } else {
    const pages: string[] = ["index.html"];
    if (c.local_page_selections.services) pages.push("services.html");
    if (c.local_page_selections.contact) pages.push("contact.html");
    if (c.local_page_selections.privacy) pages.push("privacy.html");
    if (c.local_page_selections.terms) pages.push("terms.html");
    payload.pages = pages;
  }

  // Niche builds fall back to gitpage's default services. servicesList is sent
  // only when the user turns off "let AI do services" and supplies a list.
  const includeServices = niche
    ? true
    : c.local_page_selections.services && !!c.services_config;

  if (includeServices && c.services_config) {
    payload.letAiDoServices = c.services_config.let_ai_do_services;
    if (
      !c.services_config.let_ai_do_services &&
      c.services_config.services_list.trim()
    ) {
      payload.servicesList = c.services_config.services_list.trim();
    }
  }

  // Niche forces contact.html, so business details are always sent; generic
  // builds send them only with the contact page.
  const includeBusiness = niche
    ? !!c.business_details
    : c.local_page_selections.contact && !!c.business_details;

  if (includeBusiness && c.business_details) {
    const b = c.business_details;
    Object.assign(payload, {
      businessName: b.business_name,
      businessStreet: b.business_street,
      businessCity: b.business_city,
      ...(b.business_state && { businessState: b.business_state }),
      ...(b.business_country && { businessCountry: b.business_country }),
      ...(b.business_zip && { businessZip: b.business_zip }),
      ...(b.business_phone && { businessPhone: b.business_phone }),
      ...(b.business_email && { businessEmail: b.business_email }),
      ...(b.opening_hours && { openingHours: b.opening_hours }),
      ...(b.google_rating && { googleRating: b.google_rating }),
      ...(b.google_review_count && {
        googleReviewCount: b.google_review_count,
      }),
    });
  }

  return payload;
}

/**
 * Tell gitpage products changed so it re-syncs the shop pages on this
 * sub-account's live sites. Slow (it commits to each site), hence the long
 * timeout; a 503 asks us to retry.
 */
export async function notifyProductsChanged(input: {
  subAccountId: string;
  productIds: string[];
  reason: "updated" | "archived" | "unlisted";
}): Promise<{ sites: { pageId: string; status: string; reason?: string }[] }> {
  const res = await fetch(`${getBaseUrl()}/api/v1/leadstack/products-changed`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(290_000),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const message =
      typeof body.message === "string"
        ? body.message
        : typeof body.error === "string"
          ? body.error
          : `gitpage request failed: ${res.status}`;
    throw new GitpageError(message, res.status, body);
  }
  return { sites: Array.isArray(body.sites) ? (body.sites as { pageId: string; status: string }[]) : [] };
}
