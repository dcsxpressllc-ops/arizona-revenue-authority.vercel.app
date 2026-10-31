import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import {
  BUSINESS_TYPES,
  GET_LEADS_CUSTOM_TYPE_MAX_LEN,
  GET_LEADS_MAX_CUSTOM_TYPES,
  slugifyBusinessType,
} from "@/lib/get-leads/business-types";
import type { SubAccountDoc } from "@/types";

/**
 * Get Leads custom service types. PUT replaces the whole list. Admin-only:
 * saved labels join the search allowlist and spend the agency's Outscraper
 * credits, so collaborators can use them but not create them.
 */

export async function PUT(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const db = getAdminDb();
  const subRef = db.doc(`subAccounts/${subAccountId}`);
  const subSnap = await subRef.get();
  if (!subSnap.exists) {
    return NextResponse.json({ error: "Sub-account not found" }, { status: 404 });
  }
  const sub = subSnap.data() as SubAccountDoc;

  if (sub.getLeadsEnabledByAgency !== true) {
    return NextResponse.json(
      { error: "Get Leads is locked by your agency." },
      { status: 403 },
    );
  }

  let body: { types?: unknown; hidden?: unknown };
  try {
    body = (await request.json()) as { types?: unknown; hidden?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!Array.isArray(body.types)) {
    return NextResponse.json(
      { error: "`types` must be an array of service names." },
      { status: 400 },
    );
  }

  // Curated entries hidden from this picker. Presentation only (search still
  // accepts curated values); checked against real values so junk can't pile up.
  const curatedValues = new Set(BUSINESS_TYPES.map((t) => t.value));
  const hidden = Array.isArray(body.hidden)
    ? [...new Set(
        body.hidden.filter(
          (v): v is string => typeof v === "string" && curatedValues.has(v),
        ),
      )]
    : [];

  // Dedupe by slug, so "Vegan Bakery" and "vegan bakery" can't coexist.
  const seen = new Set<string>();
  const types: string[] = [];
  for (const raw of body.types) {
    if (typeof raw !== "string") continue;
    const label = raw.replace(/[\r\n\t]/g, " ").trim().slice(0, GET_LEADS_CUSTOM_TYPE_MAX_LEN);
    if (label.length < 2) continue;
    const slug = slugifyBusinessType(label);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    types.push(label);
  }
  if (types.length > GET_LEADS_MAX_CUSTOM_TYPES) {
    return NextResponse.json(
      { error: `At most ${GET_LEADS_MAX_CUSTOM_TYPES} custom service types.` },
      { status: 400 },
    );
  }

  await subRef.update({
    getLeadsCustomTypes: types,
    getLeadsHiddenTypes: hidden,
    updatedAt: FieldValue.serverTimestamp(),
  });

  return NextResponse.json({ ok: true, types, hidden });
}
