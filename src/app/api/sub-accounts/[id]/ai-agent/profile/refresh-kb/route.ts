import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { siteAddress, type WebsiteDoc } from "@/types/website";
import { getAdminDb } from "@/lib/firebase/admin";
import { getAgentProfile, upsertAgentProfile } from "@/lib/comms/ai/agent";
import { anyAiChannelGateOn } from "@/lib/comms/ai/gates";
import {
  firecrawlIsConfigured,
  scrapeUrl,
  FirecrawlError,
} from "@/lib/firecrawl/client";
import type { SubAccountDoc } from "@/types";

export const dynamic = "force-dynamic";

/** ~1500 tokens. Every inbound reply reads this in the system prompt, so
 *  keep it small. */
const MAX_KB_CHARS = 6000;

/**
 * Scrapes the profile's websiteUrl with Firecrawl and stores the markdown as
 * `websiteKb` (+ `websiteKbFetchedAt`). Admin-only. 400 with no URL, 503 if
 * Firecrawl isn't configured, 502 if it rejects the URL. Errors keep the
 * previous KB.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const auth = await requireSubAccountAdmin(request, id);
  if (auth instanceof NextResponse) return auth;

  // Scraping spends shared credits; only allowed when the agency has enabled
  // at least one AI channel for this sub-account.
  const saSnap = await getAdminDb().doc(`subAccounts/${id}`).get();
  const sa = saSnap.exists ? (saSnap.data() as SubAccountDoc) : null;
  if (!sa || !anyAiChannelGateOn(sa)) {
    return NextResponse.json(
      {
        error:
          "AI is disabled for this sub-account by your agency. Ask your agency owner to enable an AI channel first.",
      },
      { status: 403 },
    );
  }

  if (!firecrawlIsConfigured()) {
    return NextResponse.json(
      {
        error:
          "Firecrawl is not configured. Set FIRECRAWL_API_KEY on the agency deployment.",
      },
      { status: 503 },
    );
  }

  // Optional { siteId }: refresh from every page of one of this sub-account's
  // built sites (the "Refresh chat knowledge" button on a site card).
  let siteId: string | null = null;
  try {
    const body = (await request.json()) as { siteId?: unknown };
    siteId = typeof body?.siteId === "string" && body.siteId.trim() ? body.siteId.trim() : null;
  } catch {
    siteId = null;
  }
  if (siteId) {
    return refreshFromSite(id, siteId);
  }

  const profile = await getAgentProfile(id);
  const url = profile?.websiteUrl?.trim();
  if (!url) {
    return NextResponse.json(
      { error: "Save a website URL on the agent profile first." },
      { status: 400 },
    );
  }

  let result;
  try {
    result = await scrapeUrl(url, { subAccountId: id });
  } catch (err) {
    if (err instanceof FirecrawlError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.status >= 500 ? 502 : 400 },
      );
    }
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(`[ai-agent/refresh-kb] sa=${id} failed:`, msg);
    return NextResponse.json(
      { error: "Failed to fetch the website. Try again in a minute." },
      { status: 502 },
    );
  }

  const kb = result.markdown.slice(0, MAX_KB_CHARS);
  await upsertAgentProfile(id, {
    websiteKb: kb,
    websiteKbFetchedAt: FieldValue.serverTimestamp(),
  });

  const updated = await getAgentProfile(id);
  return NextResponse.json({
    ok: true,
    profile: updated,
    chars: kb.length,
    truncated: result.markdown.length > MAX_KB_CHARS,
  });
}


const SITE_PAGE_ORDER = ["index", "services", "contact"] as const;

/**
 * Scrapes a built site's content pages (legal pages skipped) into the KB,
 * labelled per page. The site doc is read under this sub-account's path.
 */
async function refreshFromSite(subAccountId: string, siteId: string) {
  const snap = await getAdminDb()
    .doc(`subAccounts/${subAccountId}/website/${siteId}`)
    .get();
  const site = snap.data() as WebsiteDoc | undefined;
  if (!snap.exists || !site || site.subAccountId !== subAccountId) {
    return NextResponse.json({ error: "Website not found." }, { status: 404 });
  }
  const base = siteAddress(site)?.trim();
  if (!base || site.status !== "ready") {
    return NextResponse.json(
      { error: "That site isn't live yet — build it first." },
      { status: 400 },
    );
  }
  const sel = site.config?.local_page_selections;
  const isVsl = site.config?.build_type === "vsl";
  const pages = SITE_PAGE_ORDER.filter(
    (p) => p === "index" || (!isVsl && sel?.[p] === true),
  );
  const root = base.replace(/\/$/, "");
  const parts: string[] = [];
  const failures: string[] = [];
  for (const p of pages) {
    const url = p === "index" ? `${root}/` : `${root}/${p}.html`;
    try {
      const r = await scrapeUrl(url, { subAccountId });
      parts.push(`## ${p === "index" ? "Home" : p[0].toUpperCase() + p.slice(1)} page\n\n${r.markdown.trim()}`);
    } catch (err) {
      failures.push(`${p}: ${err instanceof Error ? err.message : "failed"}`);
    }
  }
  if (!parts.length) {
    return NextResponse.json(
      { error: `Couldn't read the site (${failures.join("; ")}). Try again in a minute.` },
      { status: 502 },
    );
  }
  const joined = parts.join("\n\n");
  const kb = joined.slice(0, MAX_KB_CHARS);
  await upsertAgentProfile(subAccountId, {
    websiteUrl: base,
    websiteKb: kb,
    websiteKbFetchedAt: FieldValue.serverTimestamp(),
    websiteKbSource: "firecrawl",
    websiteKbSiteId: siteId,
  });
  return NextResponse.json({
    ok: true,
    pages: pages.length - failures.length,
    failures,
    chars: kb.length,
    truncated: joined.length > MAX_KB_CHARS,
  });
}
