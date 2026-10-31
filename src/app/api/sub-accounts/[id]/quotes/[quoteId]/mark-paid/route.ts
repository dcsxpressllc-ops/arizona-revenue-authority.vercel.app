import { NextResponse } from "next/server";

import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { territoryGateForContact } from "@/lib/auth/territory-filter";
import { markQuotePaidServerSide } from "@/lib/server/quotes-service";
import type { Quote } from "@/types/quotes";

export const dynamic = "force-dynamic";

/**
 * POST .../quotes/[quoteId]/mark-paid
 * For payment collected off-system. Any member. quote: accepted -> paid;
 * invoice: sent | viewed -> paid. 409 otherwise (draft, declined, already
 * paid).
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; quoteId: string }> },
): Promise<NextResponse> {
  const { id: subAccountId, quoteId } = await params;

  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const db = getAdminDb();
  const quoteRef = db.collection("quotes").doc(quoteId);
  const quoteSnap = await quoteRef.get();
  if (!quoteSnap.exists) {
    return NextResponse.json({ error: "Quote not found" }, { status: 404 });
  }
  const quote = quoteSnap.data() as Quote;
  if (quote.subAccountId !== subAccountId) {
    return NextResponse.json(
      { error: "Quote belongs to a different sub-account" },
      { status: 403 },
    );
  }
  const gate = await territoryGateForContact(access, quote.contactId);
  if (gate) return gate;

  // Checks, write and side effects (activity, `quote.paid` trigger, webhook,
  // review request) live in lib/server/quotes-service.ts, shared with the
  // Stripe order reconciler.
  const result = await markQuotePaidServerSide({
    quoteId,
    expectSubAccountId: subAccountId,
  });

  if (!result.ok) {
    const status =
      result.code === "not_found"
        ? 404
        : result.code === "wrong_tenant"
          ? 403
          : 409;
    return NextResponse.json({ error: result.message }, { status });
  }

  return NextResponse.json({ ok: true });
}
