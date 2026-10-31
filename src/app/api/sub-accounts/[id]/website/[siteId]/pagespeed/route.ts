import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { qstashIsConfigured, verifyQStashSignature } from "@/lib/automations/qstash";
import { runPageSpeed } from "@/lib/server/website-pagespeed";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Run PageSpeed Insights (mobile) on a live site and store the scores.
 * Called by QStash ~2 min after publish (signature-checked, hence the public
 * path) and by an admin's "Re-check" (session auth).
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string; siteId: string }> },
) {
  const { id: subAccountId, siteId } = await ctx.params;
  const signature = request.headers.get("upstash-signature");

  if (signature) {
    if (!qstashIsConfigured()) {
      return NextResponse.json({ error: "QStash is not configured." }, { status: 503 });
    }
    const raw = await request.text();
    if (!(await verifyQStashSignature(signature, raw))) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
    let body: { subAccountId?: string; siteId?: string } = {};
    try {
      body = JSON.parse(raw);
    } catch {
    }
    if (body.subAccountId !== subAccountId || body.siteId !== siteId) {
      return NextResponse.json({ error: "Body ids must match the path." }, { status: 400 });
    }
  } else {
    const access = await requireSubAccountAdmin(request, subAccountId);
    if (access instanceof NextResponse) return access;
  }

  const result = await runPageSpeed(subAccountId, siteId);
  if (!result) return NextResponse.json({ ok: true, ignored: "site-not-live" });
  return NextResponse.json({ ok: true, pagespeed: { ...result, at: null } });
}
