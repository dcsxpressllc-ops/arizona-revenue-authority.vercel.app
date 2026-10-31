import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  fetchTemplates,
  GitpageError,
  gitpageIsConfigured,
  removeTemplate,
  saveTemplate,
  type GitpageTemplate,
} from "@/lib/gitpage/client";
import type { WebsiteDoc } from "@/types/website";

export const dynamic = "force-dynamic";

/**
 * POST { name } / DELETE: save this built site as a gitpage "Agency
 * template" (or rename it), or stop it being one. The site stays live.
 * Agency owners save for every client, or this client only with
 * `scope: "client"`. Client admins can only save templates for their own
 * sub-account (gitpage refuses changes to agency templates). gitpage checks
 * the rest: its site, published, on GitLab, templates enabled.
 */
async function siteFor(subAccountId: string, siteId: string): Promise<WebsiteDoc | null> {
  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}/website/${siteId}`).get();
  const doc = snap.exists ? (snap.data() as WebsiteDoc) : null;
  return doc && doc.subAccountId === subAccountId ? doc : null;
}

function errorResponse(err: unknown, fallback: string) {
  if (err instanceof GitpageError) {
    return NextResponse.json({ error: err.message }, { status: err.status >= 500 ? 502 : err.status });
  }
  const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
  return NextResponse.json({ error: timedOut ? "gitpage didn't answer in time — please try again." : err instanceof Error ? err.message : fallback }, { status: 502 });
}

/**
 * Older gitpage versions don't know client templates and would save for
 * every client. Returns the site's current template entry, or a refusal.
 */
async function clientTemplateCheck(
  subAccountId: string,
  pageId: string,
  isAgencyOwner: boolean,
): Promise<{ current: GitpageTemplate | null } | { response: NextResponse }> {
  const list = await fetchTemplates(subAccountId);
  if (!list.enabled) {
    return { response: NextResponse.json({ error: "Agency templates aren't switched on for this gitpage account." }, { status: 404 }) };
  }
  if (!list.clientTemplates) {
    return { response: NextResponse.json({ error: "Templates for one client need a newer gitpage. Ask your agency to update." }, { status: 409 }) };
  }
  const current = list.templates.find((t) => t.templateId === pageId) ?? null;
  if (!isAgencyOwner && current?.scope === "agency") {
    return { response: NextResponse.json({ error: "This is one of your agency's templates. Only the agency can change it." }, { status: 403 }) };
  }
  return { current };
}

async function guard(request: Request, ctx: { params: Promise<{ id: string; siteId: string }> }) {
  const { id: subAccountId, siteId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return { response: access };
  if (!gitpageIsConfigured()) {
    return { response: NextResponse.json({ error: "gitpage is not configured on this deployment (GITPAGE_API_KEY missing)." }, { status: 503 }) };
  }
  const site = await siteFor(subAccountId, siteId);
  if (!site) return { response: NextResponse.json({ error: "Website not found in this workspace." }, { status: 404 }) };
  if (site.status !== "ready" || !site.gitpagePageId) {
    return { response: NextResponse.json({ error: "Only a published site can be a template. Build it first." }, { status: 400 }) };
  }
  return { site, subAccountId, isAgencyOwner: access.subAccountRole === "agencyOwner" };
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string; siteId: string }> },
) {
  const g = await guard(request, ctx);
  if ("response" in g) return g.response;
  const body = (await request.json().catch(() => ({}))) as { name?: unknown; scope?: unknown };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "Give the template a name." }, { status: 400 });
  if (name.length > 60) return NextResponse.json({ error: "Keep the name under 60 characters." }, { status: 400 });
  try {
    const pageId = g.site.gitpagePageId as string;
    const scope = body.scope === "client" || body.scope === "agency" ? body.scope : undefined;
    const wantsClient = !g.isAgencyOwner || scope === "client";
    let existed = false;
    if (wantsClient) {
      const check = await clientTemplateCheck(g.subAccountId, pageId, g.isAgencyOwner);
      if ("response" in check) return check.response;
      existed = !!check.current;
    }
    const template = await saveTemplate(pageId, name, g.isAgencyOwner ? { scope } : { client: g.subAccountId });
    // A client template must come back as one.
    if (wantsClient && template?.scope !== "client") {
      if (!existed) await removeTemplate(pageId).catch(() => {});
      return NextResponse.json({ error: "gitpage didn't save it for this client only. Ask your agency to update gitpage." }, { status: 409 });
    }
    return NextResponse.json({ ok: true, isTemplate: true, template });
  } catch (err) {
    return errorResponse(err, "Could not save the template.");
  }
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string; siteId: string }> },
) {
  const g = await guard(request, ctx);
  if ("response" in g) return g.response;
  try {
    if (!g.isAgencyOwner) {
      const check = await clientTemplateCheck(g.subAccountId, g.site.gitpagePageId as string, false);
      if ("response" in check) return check.response;
    }
    await removeTemplate(g.site.gitpagePageId as string, g.isAgencyOwner ? undefined : g.subAccountId);
    return NextResponse.json({ ok: true, isTemplate: false });
  } catch (err) {
    return errorResponse(err, "Could not remove the template.");
  }
}
