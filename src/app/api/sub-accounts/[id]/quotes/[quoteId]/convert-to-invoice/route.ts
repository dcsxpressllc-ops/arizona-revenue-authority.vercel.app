import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { territoryGateForContact } from "@/lib/auth/territory-filter";
import { issueQuoteNumber } from "@/lib/quotes/number";
import type { Quote } from "@/types/quotes";

export const dynamic = "force-dynamic";

/**
 * POST .../quotes/[quoteId]/convert-to-invoice
 * Converts an accepted quote into an invoice in place: kind -> "invoice",
 * status -> "draft" (Send mints the payment link and emails it), a fresh
 * INV-YYYY-NNNN number from the invoice counter, publicTokenHash cleared so
 * the old /q/[token] link dies, and convertedFromQuoteAt stamped.
 * Only accepted quotes; converting a declined/expired one would be a footgun.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; quoteId: string }> },
): Promise<NextResponse> {
  const { id: subAccountId, quoteId } = await params;

  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const db = getAdminDb();
  const ref = db.collection("quotes").doc(quoteId);
  const snap = await ref.get();
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
  if (quote.kind === "invoice") {
    return NextResponse.json(
      { error: "Already an invoice" },
      { status: 400 },
    );
  }
  if (quote.status !== "accepted") {
    return NextResponse.json(
      {
        error:
          "Only accepted quotes can be converted to invoices. Mark the quote accepted first.",
      },
      { status: 400 },
    );
  }

  let invoiceNumber: string;
  try {
    invoiceNumber = await issueQuoteNumber(subAccountId, "invoice");
  } catch (err) {
    console.error("[convert-to-invoice] issueQuoteNumber failed", err);
    return NextResponse.json(
      { error: "Failed to allocate invoice number" },
      { status: 500 },
    );
  }

  // `signature` is deliberately left untouched: the invoice is the same executed
  // document with a payment step, so the certificate page stays on its PDF. A
  // signed document can't be edited afterwards, so give it the builder's
  // default payment term here rather than leaving it with none.
  try {
    await ref.update({
      kind: "invoice",
      quoteNumber: invoiceNumber,
      status: "draft",
      paymentDueDays: quote.paymentDueDays ?? 7,
      publicTokenHash: "",
      sentAt: null,
      viewedAt: null,
      paymentLinkUrl: null,
      paymentLinkId: null,
      paymentLinkMintedAt: null,
      convertedFromQuoteAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error("[convert-to-invoice] write failed", err);
    return NextResponse.json(
      { error: "Failed to convert quote to invoice" },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    invoiceNumber,
  });
}
