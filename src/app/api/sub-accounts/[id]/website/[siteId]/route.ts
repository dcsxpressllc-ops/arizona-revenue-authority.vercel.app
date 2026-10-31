import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import type { WebsiteConfig, WebsiteDoc } from "@/types/website";
import { hideWebsiteInGitpage, rememberDeletedWebsite } from "@/lib/server/website-import-service";
import { buildInFlight } from "@/lib/server/websites-service";

const WIZARD_STEPS = new Set(["start", "business", "pages", "video", "location", "look", "story", "review"]);
const MAX_CONFIG_BYTES = 100_000;

/**
 * PATCH: save the wizard draft on each Next, plus the step to resume on.
 * Shape/size checks only (the build route validates fully). Refused while a
 * build is in flight so the running job's config can't change. Never
 * touches status, job id or live URL.
 */
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string; siteId: string }> },
) {
  const { id: subAccountId, siteId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: { config?: WebsiteConfig; wizardStep?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const config = body.config;
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return NextResponse.json({ error: "Body must include a `config` object." }, { status: 400 });
  }
  if (JSON.stringify(config).length > MAX_CONFIG_BYTES) {
    return NextResponse.json({ error: "That draft is too large to save." }, { status: 413 });
  }
  const wizardStep =
    typeof body.wizardStep === "string" && WIZARD_STEPS.has(body.wizardStep) ? body.wizardStep : null;

  const docRef = getAdminDb().doc(`subAccounts/${subAccountId}/website/${siteId}`);
  const snap = await docRef.get();
  if (!snap.exists || (snap.data() as WebsiteDoc).subAccountId !== subAccountId) {
    return NextResponse.json({ error: "Website not found." }, { status: 404 });
  }
  if (buildInFlight(snap.data() as WebsiteDoc)) {
    return NextResponse.json(
      { error: "This site is building right now — wait for it to finish before editing." },
      { status: 409 },
    );
  }
  // System fields stay server-owned.
  const clean: WebsiteConfig = { ...config, site_type: "LocalSite", astra_theme: false };
  await docRef.update({
    config: clean,
    wizardStep,
    updatedAt: FieldValue.serverTimestamp(),
  });
  return NextResponse.json({ ok: true });
}

/**
 * DELETE a website.
 * ?reset=1: back to draft for "Rebuild". Clears gitpageJobId, liveUrl,
 * status and errors; keeps config. The old GitHub repo stays live until
 * deleted on gitpage's side.
 * No flag: delete the doc and free a site slot. The published site is
 * hidden in gitpage (still live, can be unhidden) and never re-imported.
 */
export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string; siteId: string }> },
) {
  const { id: subAccountId, siteId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const reset = new URL(request.url).searchParams.get("reset") === "1";

  const db = getAdminDb();
  const docRef = db.doc(`subAccounts/${subAccountId}/website/${siteId}`);
  const snap = await docRef.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "No website to remove." }, { status: 404 });
  }

  if (reset) {
    // The running job's site would be orphaned. A stuck build can still be reset.
    if (buildInFlight(snap.data() as WebsiteDoc)) {
      return NextResponse.json(
        { error: "That site is building right now — wait for it to finish." },
        { status: 409 },
      );
    }
    await docRef.update({
      status: "draft",
      gitpageJobId: null,
      liveUrl: null,
      errorMessage: null,
      partialErrors: null,
      pollAttempts: 0,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return NextResponse.json({ ok: true, reset: true });
  }

  const doc = snap.data() as WebsiteDoc;
  const ours = doc.subAccountId === subAccountId;
  if (ours) await rememberDeletedWebsite(subAccountId, doc);
  await docRef.delete();
  if (ours) await hideWebsiteInGitpage(subAccountId, doc);
  return NextResponse.json({ ok: true, removed: true });
}
