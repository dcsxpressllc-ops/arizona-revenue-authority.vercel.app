import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import {
  fetchTemplates,
  GitpageError,
  gitpageIsConfigured,
} from "@/lib/gitpage/client";

export const dynamic = "force-dynamic";

/**
 * GET .../website/templates -> { enabled, templates }
 * Proxies gitpage's GET /api/v1/templates (agency templates + this
 * sub-account's client templates) for the template picker and "Save as
 * template". Admin-only, since names and previews are often other clients'
 * sites. `enabled` = templates are switched on in gitpage, even with none
 * saved.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const headers = { "Cache-Control": "private, no-store" };
  if (!gitpageIsConfigured()) {
    return NextResponse.json({ enabled: false, templates: [] }, { headers });
  }

  try {
    const result = await fetchTemplates(subAccountId);
    return NextResponse.json(result, { headers });
  } catch (err) {
    if (err instanceof GitpageError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.status >= 500 ? 502 : err.status },
      );
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not load templates." },
      { status: 502 },
    );
  }
}
