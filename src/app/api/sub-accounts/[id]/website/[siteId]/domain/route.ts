import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import {
  getAgentProfile,
  getChannelConfig,
  upsertAgentProfile,
  upsertChannelConfig,
} from "@/lib/comms/ai/agent";
import { DEFAULT_WEB_CHAT_CONFIG } from "@/types/ai";
import type { WebsiteDoc } from "@/types/website";

export const dynamic = "force-dynamic";

/**
 * PUT { domain }: record a live site's custom domain, allow-list it (and its
 * www/apex twin) for the Web Chat widget, and repoint the chat bot's
 * website URL if the bot was seeded from this site.
 * DELETE: clear it and remove the domains this route added.
 * The domain itself is set up in GitLab/GitHub; this only syncs our side.
 */

const HOST_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function normaliseDomain(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let d = raw.trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, "").split(/[/?#]/)[0].replace(/:\d+$/, "").replace(/\.$/, "");
  if (!HOST_RE.test(d)) return null;
  if (/\.(gitlab|github)\.io$/.test(d)) return null;
  return d;
}

/** Visitors may arrive on either. */
function variants(domain: string): string[] {
  if (domain.startsWith("www.")) return [domain, domain.slice(4)];
  return domain.split(".").length === 2 ? [domain, `www.${domain}`] : [domain];
}

async function loadSite(subAccountId: string, siteId: string) {
  const ref = getAdminDb().doc(`subAccounts/${subAccountId}/website/${siteId}`);
  const snap = await ref.get();
  const site = snap.data() as WebsiteDoc | undefined;
  if (!snap.exists || !site || site.subAccountId !== subAccountId) return null;
  return { ref, site };
}

async function syncChat(subAccountId: string, add: string[], remove: string[]) {
  const existing = await getChannelConfig(subAccountId, "web-chat");
  const webChat = { ...DEFAULT_WEB_CHAT_CONFIG, ...(existing?.webChat ?? {}) };
  const set = new Set(webChat.allowedDomains.map((d) => d.toLowerCase()));
  for (const d of remove) set.delete(d);
  for (const d of add) set.add(d);
  webChat.allowedDomains = [...set];
  await upsertChannelConfig(subAccountId, "web-chat", { webChat });
}

export async function PUT(
  request: Request,
  ctx: { params: Promise<{ id: string; siteId: string }> },
) {
  const { id: subAccountId, siteId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: { domain?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const domain = normaliseDomain(body.domain);
  if (!domain) {
    return NextResponse.json(
      { error: "Enter a domain like www.yourbusiness.com (not a gitlab.io or github.io address)." },
      { status: 400 },
    );
  }

  const found = await loadSite(subAccountId, siteId);
  if (!found) return NextResponse.json({ error: "Website not found." }, { status: 404 });
  const { ref, site } = found;
  if (site.status !== "ready") {
    return NextResponse.json({ error: "Add a custom domain once the site is live." }, { status: 409 });
  }

  const previous = site.customDomain ?? null;
  const warnings: string[] = [];
  try {
    await syncChat(subAccountId, variants(domain), previous && previous !== domain ? variants(previous) : []);
  } catch (err) {
    warnings.push(`Chat allow-list not updated: ${err instanceof Error ? err.message : "unknown error"}`);
  }

  // Only when the bot was seeded from this site, or still points at its
  // gitlab/github URL.
  try {
    const profile = await getAgentProfile(subAccountId);
    const pointsHere =
      profile?.websiteKbSiteId === siteId ||
      (!!site.liveUrl && profile?.websiteUrl === site.liveUrl) ||
      (!!previous && profile?.websiteUrl === `https://${previous}/`);
    if (pointsHere) await upsertAgentProfile(subAccountId, { websiteUrl: `https://${domain}/` });
  } catch (err) {
    warnings.push(`Chat bot website not updated: ${err instanceof Error ? err.message : "unknown error"}`);
  }

  await ref.update({ customDomain: domain, updatedAt: FieldValue.serverTimestamp() });
  return NextResponse.json({ ok: true, customDomain: domain, warnings });
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string; siteId: string }> },
) {
  const { id: subAccountId, siteId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const found = await loadSite(subAccountId, siteId);
  if (!found) return NextResponse.json({ error: "Website not found." }, { status: 404 });
  const { ref, site } = found;
  const previous = site.customDomain ?? null;
  if (previous) {
    try {
      await syncChat(subAccountId, [], variants(previous));
      const profile = await getAgentProfile(subAccountId);
      if (profile?.websiteUrl === `https://${previous}/` && site.liveUrl) {
        await upsertAgentProfile(subAccountId, { websiteUrl: site.liveUrl });
      }
    } catch {
      // best-effort; the field is still cleared below
    }
  }
  await ref.update({ customDomain: null, updatedAt: FieldValue.serverTimestamp() });
  return NextResponse.json({ ok: true });
}
