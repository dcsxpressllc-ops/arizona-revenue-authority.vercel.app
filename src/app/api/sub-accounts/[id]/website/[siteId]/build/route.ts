import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import {
  submitWebsiteBuildForSubAccount,
  WebsiteServiceError,
} from "@/lib/server/websites-service";
import type { WebsiteConfig } from "@/types/website";

/**
 * Submit a build for `subAccounts/{id}/website/{siteId}`. On success the doc
 * is saved as "queued" with the gitpage formResponseId and the first QStash
 * poll is scheduled (/website/{siteId}/poll reschedules itself until the
 * build settles). All logic is in the shared websites service (also behind
 * the AI Suite `create_website` capability); this is auth + JSON.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string; siteId: string }> },
) {
  const { id: subAccountId, siteId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: { config?: WebsiteConfig };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const config = body.config;
  if (!config || typeof config !== "object") {
    return NextResponse.json(
      { error: "Body must include `config` object." },
      { status: 400 },
    );
  }

  try {
    const submission = await submitWebsiteBuildForSubAccount({
      subAccountId,
      siteId,
      config,
      buildByUid: access.uid,
    });
    return NextResponse.json({
      ok: true,
      status: "queued",
      formResponseId: submission.formResponseId,
      estimatedDurationSeconds: submission.estimatedDurationSeconds,
    });
  } catch (err) {
    if (err instanceof WebsiteServiceError) {
      return NextResponse.json(
        {
          error: err.message,
          ...(err.fieldErrors ? { fieldErrors: err.fieldErrors } : {}),
          ...(err.gitpageStatus !== undefined
            ? { gitpageStatus: err.gitpageStatus, gitpageBody: err.gitpageBody }
            : {}),
        },
        { status: err.status },
      );
    }
    console.error("[website/build] failed", err);
    return NextResponse.json(
      { error: "Failed to submit the build." },
      { status: 500 },
    );
  }
}
