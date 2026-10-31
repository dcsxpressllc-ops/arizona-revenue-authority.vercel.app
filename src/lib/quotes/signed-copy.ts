import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { emailIsConfigured, sendEmail, tenantFrom } from "@/lib/comms/resend";
import { computeQuoteTotals } from "@/lib/quotes/calc";
import { pdfFilename, renderQuotePdfBuffer } from "@/lib/quotes/pdf-render";
import { formatCurrency } from "@/lib/format";
import type { Quote } from "@/types/quotes";
import type { SubAccountDoc } from "@/types";

/**
 * After a signed accept, both parties get the PDF with its certificate page:
 * the recipient as their copy, the operator as the notification. Best-effort
 * and silent to the recipient; the accept has already committed.
 */
export async function sendSignedCopies(quote: Quote): Promise<void> {
  if (!quote.signature) return;
  if (!emailIsConfigured()) return;

  try {
    const db = getAdminDb();
    const [contactSnap, subSnap, creatorSnap] = await Promise.all([
      db.doc(`contacts/${quote.contactId}`).get(),
      db.doc(`subAccounts/${quote.subAccountId}`).get(),
      db.doc(`users/${quote.createdByUid}`).get(),
    ]);
    const contact = (contactSnap.exists ? contactSnap.data() : null) as {
      name?: string;
      email?: string;
    } | null;
    const sub = subSnap.exists ? (subSnap.data() as SubAccountDoc) : null;
    const businessName = sub?.name || "Your business";
    const businessLogoUrl =
      typeof sub?.logoUrl === "string" && /^https?:\/\/.+/i.test(sub.logoUrl)
        ? sub.logoUrl
        : null;
    const recipientName = contact?.name?.trim() || "";
    const recipientEmail = contact?.email?.trim() || quote.signature.signerEmail;

    const creatorEmail = creatorSnap.exists
      ? (creatorSnap.data()?.email as string | undefined)
      : undefined;
    const operatorEmail =
      creatorEmail?.trim() || sub?.accountContact?.email?.trim() || null;

    // Two renders: the recipient's copy travels, so it carries no IP or
    // browser string; the operator's copy is the full certificate.
    const filename = pdfFilename(quote).replace(/\.pdf$/, "-signed.pdf");
    const [recipientPdf, operatorPdf] = await Promise.all([
      renderQuotePdfBuffer({
        quote,
        businessName,
        businessLogoUrl,
        recipientName,
        certificateDetail: "recipient",
      }),
      renderQuotePdfBuffer({
        quote,
        businessName,
        businessLogoUrl,
        recipientName,
        certificateDetail: "full",
      }),
    ]);
    const recipientAttachment = {
      filename,
      content: recipientPdf.toString("base64"),
      contentType: "application/pdf",
    };
    const operatorAttachment = {
      filename,
      content: operatorPdf.toString("base64"),
      contentType: "application/pdf",
    };

    const totals = computeQuoteTotals(quote);
    const totalDisplay = formatCurrency(totals.total, quote.currency);
    const signer = quote.signature.signerName;
    const from = tenantFrom(sub);
    const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");

    const sends: Promise<unknown>[] = [];

    if (recipientEmail) {
      sends.push(
        sendEmail({
          to: recipientEmail,
          subject: `Your signed quote ${quote.quoteNumber} from ${businessName}`,
          text: [
            `Hi ${recipientName || "there"},`,
            "",
            `Thanks for accepting quote ${quote.quoteNumber} (${totalDisplay}).`,
            `It was signed by ${signer}. Your signed copy is attached, with a signature certificate on the last page.`,
            "",
            "Reply to this email if you have any questions.",
            "",
            `— ${businessName}`,
          ].join("\n"),
          replyTo: operatorEmail ?? undefined,
          from,
          subAccount: sub,
          attachments: [recipientAttachment],
          meter: { subAccountId: quote.subAccountId },
        }),
      );
    }

    if (operatorEmail) {
      const detailUrl = appUrl
        ? `${appUrl}/sa/${quote.subAccountId}/quotes/${quote.id}`
        : null;
      sends.push(
        sendEmail({
          to: operatorEmail,
          subject: `${signer} signed quote ${quote.quoteNumber} (${totalDisplay})`,
          text: [
            `${signer} accepted and signed quote ${quote.quoteNumber} for ${recipientName || recipientEmail || "the recipient"}.`,
            `Total: ${totalDisplay}`,
            "",
            "The signed PDF is attached. The quote is now locked against edits.",
            detailUrl ? "" : null,
            detailUrl ? `Open it in the CRM: ${detailUrl}` : null,
          ]
            .filter((line): line is string => line !== null)
            .join("\n"),
          replyTo: recipientEmail ?? undefined,
          from,
          attachments: [operatorAttachment],
          meter: { subAccountId: quote.subAccountId },
        }),
      );
    }

    const results = await Promise.allSettled(sends);
    for (const r of results) {
      if (r.status === "rejected") {
        console.warn("[quotes/signed-copy] send failed", r.reason);
      }
    }
  } catch (err) {
    console.warn("[quotes/signed-copy] failed", err);
  }
}
