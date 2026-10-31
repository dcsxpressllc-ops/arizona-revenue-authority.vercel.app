import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { MAX_WEBSITES_PER_SUBACCOUNT } from "@/lib/website/limits";
import { blankWebsiteConfig, type WebsiteConfig, type WebsiteDoc } from "@/types/website";
import { fetchClientSites, gitpageIsConfigured, hideClientSite, renameClientSites } from "@/lib/gitpage/client";

/**
 * Sites the client made in gitpage. Client editors can duplicate a site
 * LeadStack built; the copy sits on the agency's gitpage account tagged with the
 * same sub-account, and syncClientSitesFromGitpage imports unknown copies as
 * ready website docs (within the cap). Deleting hides the site in gitpage and
 * leaves a tombstone so it never comes back. The sync also pushes the
 * sub-account name for gitpage's Client filter. Imported ids are `gp-<pageId>`,
 * so concurrent syncs can't double-import.
 */

const dismissedPath = (subAccountId: string, pageId: string) =>
  `subAccounts/${subAccountId}/websiteDismissed/${pageId}`;

export async function syncClientSitesFromGitpage(subAccountId: string): Promise<{ imported: number }> {
  if (!gitpageIsConfigured()) return { imported: 0 };
  const db = getAdminDb();
  const sub = await db.doc(`subAccounts/${subAccountId}`).get();
  const subData = sub.exists ? (sub.data() as Record<string, unknown>) : null;
  if (!subData || subData.websiteEnabledByAgency !== true || typeof subData.agencyId !== "string") {
    return { imported: 0 };
  }

  const name = typeof subData.name === "string" ? subData.name.trim() : "";
  const [, sites] = await Promise.all([
    name ? renameClientSites(subAccountId, name).catch(() => {}) : null,
    fetchClientSites(subAccountId),
  ]);
  const copies = sites.filter((s) => s.origin === "duplicate" && s.status === "Published" && s.liveUrl);
  if (!copies.length) return { imported: 0 };

  const col = db.collection(`subAccounts/${subAccountId}/website`);
  const existing = (await col.get()).docs.map((d) => d.data() as WebsiteDoc);
  const known = new Set(existing.map((d) => d.gitpagePageId).filter(Boolean) as string[]);
  const byPageId = new Map(existing.filter((d) => d.gitpagePageId).map((d) => [d.gitpagePageId as string, d]));

  let count = existing.length;
  let imported = 0;
  for (const site of copies) {
    if (count >= MAX_WEBSITES_PER_SUBACCOUNT) break;
    if (known.has(site.pageId)) continue;
    if ((await db.doc(dismissedPath(subAccountId, site.pageId)).get()).exists) continue;

    const source = site.duplicatedFrom ? byPageId.get(site.duplicatedFrom) : undefined;
    const sourceName = source?.name || source?.config?.heading || null;
    const config: WebsiteConfig = source?.config ? { ...blankWebsiteConfig(), ...source.config } : blankWebsiteConfig();
    const ref = col.doc(`gp-${site.pageId}`);
    const now = FieldValue.serverTimestamp();
    try {
      await ref.create({
        id: ref.id,
        agencyId: subData.agencyId,
        subAccountId,
        name: sourceName ? `${sourceName} (copy)`.slice(0, 80) : site.repoName || "Website copy",
        status: "ready",
        gitpageJobId: null,
        liveUrl: site.liveUrl,
        errorMessage: null,
        partialErrors: null,
        pollAttempts: 0,
        lastBuildAt: null,
        lastBuildByUid: null,
        config,
        quality: site.quality,
        gitpagePageId: site.pageId,
        customDomain: site.customDomain,
        importedFrom: "gitpage",
        statusPhase: "completed",
        createdAt: now,
        updatedAt: now,
      });
      imported++;
      count++;
      known.add(site.pageId);
    } catch (err) {
      // A concurrent sync got there first (ALREADY_EXISTS).
      if ((err as { code?: number }).code !== 6) throw err;
    }
  }
  return { imported };
}

/** Current page, the one an in-progress build replaces, and the imported source. */
function pageIdsOf(doc: WebsiteDoc): string[] {
  const ids = [doc.gitpagePageId, doc.replacesGitpagePageId, doc.id?.startsWith("gp-") ? doc.id.slice(3) : null];
  return [...new Set(ids.filter((id): id is string => !!id))];
}

/** Tombstone a deleted website's gitpage sites. Call before deleting the doc, or
 *  a sync in between brings it back. Never throws. */
export async function rememberDeletedWebsite(subAccountId: string, doc: WebsiteDoc): Promise<void> {
  const db = getAdminDb();
  for (const pageId of pageIdsOf(doc)) {
    try {
      await db.doc(dismissedPath(subAccountId, pageId)).set({ pageId, dismissedAt: FieldValue.serverTimestamp() });
    } catch (err) {
      console.error("[website delete] tombstone failed:", err);
    }
  }
}

/** Hide the deleted website's gitpage sites (still live; unhide in gitpage).
 *  Never throws, so the LeadStack delete always succeeds. */
export async function hideWebsiteInGitpage(subAccountId: string, doc: WebsiteDoc): Promise<void> {
  if (!gitpageIsConfigured()) return;
  for (const pageId of pageIdsOf(doc)) {
    try {
      await hideClientSite(pageId, subAccountId);
    } catch (err) {
      console.error("[website delete] could not hide the site in gitpage:", err);
    }
  }
}
