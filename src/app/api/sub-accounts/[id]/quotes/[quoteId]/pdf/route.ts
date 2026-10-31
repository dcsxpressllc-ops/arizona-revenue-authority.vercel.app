import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { territoryGateForContact } from "@/lib/auth/territory-filter";
import { pdfFilename, renderQuotePdfStream } from "@/lib/quotes/pdf-render";
import type { Quote } from "@/types/quotes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET .../quotes/[quoteId]/pdf: operator PDF download (members). Same
 * renderer as the public /api/quotes/[token]/pdf; only the auth differs.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; quoteId: string }> },
): Promise<Response> {
  const { id: subAccountId, quoteId } = await params;

  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const db = getAdminDb();
  const snap = await db.collection("quotes").doc(quoteId).get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Quote not found" }, { status: 404 });
  }
  const quote = { id: snap.id, ...(snap.data() as Omit<Quote, "id">) };
  if (quote.subAccountId !== subAccountId) {
    return NextResponse.json(
      { error: "Quote belongs to a different sub-account" },
      { status: 403 },
    );
  }
  const gate = await territoryGateForContact(access, quote.contactId);
  if (gate) return gate;

  const [contactSnap, subSnap] = await Promise.all([
    db.doc(`contacts/${quote.contactId}`).get(),
    db.doc(`subAccounts/${subAccountId}`).get(),
  ]);
  const contact = (contactSnap.exists ? contactSnap.data() : null) as {
    name?: string;
    email?: string;
    phone?: string;
  } | null;
  const recipientName = contact
    ? contact.name?.trim() ||
      contact.email?.trim() ||
      contact.phone?.trim() ||
      "(unnamed contact)"
    : "(deleted contact)";
  const subData = subSnap.exists ? (subSnap.data() ?? {}) : {};
  const businessName =
    (subData.name as string | undefined) || "Your business";
  const businessLogoUrl =
    typeof subData.logoUrl === "string" ? (subData.logoUrl as string) : null;

  const stream = await renderQuotePdfStream({
    quote,
    businessName,
    businessLogoUrl,
    recipientName,
  });
  return new NextResponse(stream, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${pdfFilename(quote)}"`,
      "Cache-Control": "no-store",
    },
  });
}
