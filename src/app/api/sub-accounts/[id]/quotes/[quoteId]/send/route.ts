import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { territoryGateForContact } from "@/lib/auth/territory-filter";
import { emailIsConfigured, sendEmail, tenantFrom } from "@/lib/comms/resend";
import { renderQuoteEmail } from "@/lib/quotes/email";
import {
  emitQuoteWebhook,
  fireQuoteTrigger,
  recordQuoteActivity,
} from "@/lib/quotes/lifecycle";
import { buildQuoteUrl, issueQuoteToken } from "@/lib/quotes/token";
import { buildPaypalInvoiceUrl } from "@/lib/paypal/payment-link";
import type { Quote } from "@/types/quotes";
import type { SubAccountDoc } from "@/types";
import { runAfterResponse } from "@/lib/server/after-response";

export const dynamic = "force-dynamic";

/**
 * POST .../quotes/[quoteId]/send: send or re-send a quote/invoice.
 *
 * Invoices need a ready Stripe connection (card pay happens on /q/[token])
 * or a PayPal username; the paypal.me URL is regenerated from the total on
 * every send. Each send issues a fresh HMAC token (hash stored), emails via
 * Resend with Reply-To set to the caller, then records lifecycle, activity
 * and the automation trigger.
 *
 * 503 when Resend isn't configured, or for invoices with neither Stripe nor
 * PayPal connected.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; quoteId: string }> },
): Promise<NextResponse> {
  const { id: subAccountId, quoteId } = await params;

  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  if (!emailIsConfigured()) {
    return NextResponse.json(
      {
        error:
          "Email isn't configured on this deployment — set RESEND_API_KEY + EMAIL_FROM to send quotes.",
      },
      { status: 503 },
    );
  }

  const db = getAdminDb();

  const quoteRef = db.collection("quotes").doc(quoteId);
  const quoteSnap = await quoteRef.get();
  if (!quoteSnap.exists) {
    return NextResponse.json({ error: "Quote not found" }, { status: 404 });
  }
  const quote = { id: quoteSnap.id, ...(quoteSnap.data() as Omit<Quote, "id">) };
  if (quote.subAccountId !== subAccountId) {
    return NextResponse.json(
      { error: "Quote belongs to a different sub-account" },
      { status: 403 },
    );
  }
  // Scoped collaborators can only act on quotes whose contact is in their
  // territories.
  const gate = await territoryGateForContact(access, quote.contactId);
  if (gate) return gate;

  const contactSnap = await db.doc(`contacts/${quote.contactId}`).get();
  if (!contactSnap.exists) {
    return NextResponse.json(
      { error: "Recipient contact no longer exists" },
      { status: 404 },
    );
  }
  const contact = contactSnap.data() as { email?: string; name?: string };
  const recipientEmail = contact.email?.trim();
  if (!recipientEmail) {
    return NextResponse.json(
      {
        error:
          "Contact has no email address — add one to their profile, then re-send.",
      },
      { status: 400 },
    );
  }

  const subSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  const sub = (subSnap.exists ? (subSnap.data() as SubAccountDoc) : null);
  const businessName = sub?.name || "Your business";
  const businessLogoUrl = sub?.logoUrl ?? null;

  // paypal.me URLs encode the amount inline, so regenerating on every send
  // needs no API call and leaves no old link to deactivate.
  let paymentLinkUpdate: {
    paymentLinkUrl: string;
    paymentLinkId: string | null;
    paymentLinkMintedAt: ReturnType<typeof FieldValue.serverTimestamp>;
  } | null = null;
  if (quote.kind === "invoice") {
    const paypal = sub?.paypalConfig ?? null;

    // Card or PayPal either satisfies "can this invoice be paid". The card
    // button is rendered on /q/[token] from live connection state, so there's
    // nothing to mint here.
    const cardReady =
      sub?.paymentsEnabledByAgency === true &&
      sub?.stripeConnectionMeta?.ready === true;

    if (!paypal?.username && !cardReady) {
      return NextResponse.json(
        {
          error:
            "Connect Stripe or PayPal under Settings → Payments before sending invoices.",
        },
        { status: 503 },
      );
    }

    if (paypal?.username) {
      try {
        const url = buildPaypalInvoiceUrl({ paypal, invoice: quote });
        paymentLinkUpdate = {
          paymentLinkUrl: url,
          paymentLinkId: null,
          paymentLinkMintedAt: FieldValue.serverTimestamp(),
        };
        // So the email and activity see the fresh URL.
        quote.paymentLinkUrl = url;
        quote.paymentLinkId = null;
      } catch (err) {
        console.error("[quotes/send] paypal link build failed", err);
        return NextResponse.json(
          {
            error: `Failed to build PayPal link: ${
              err instanceof Error ? err.message : "unknown error"
            }`,
          },
          { status: 500 },
        );
      }
    }
  }

  // HMAC + nonce; the raw token is never stored.
  let token: string;
  let hash: string;
  try {
    ({ token, hash } = issueQuoteToken(quoteId));
  } catch (err) {
    console.error("[quotes/send] issueQuoteToken failed", err);
    return NextResponse.json(
      {
        error:
          "Failed to mint quote token. Check AUTOMATIONS_TOKEN_SECRET is configured.",
      },
      { status: 500 },
    );
  }
  const publicUrl = buildQuoteUrl(token);
  if (!publicUrl) {
    return NextResponse.json(
      {
        error:
          "NEXT_PUBLIC_APP_URL isn't configured — set it so quote links resolve.",
      },
      { status: 503 },
    );
  }

  // Reply-To = caller so replies reach the operator. From = the sub-account's
  // verified sending domain, else the shared EMAIL_FROM.
  const email = renderQuoteEmail({
    quote,
    businessName,
    businessLogoUrl,
    recipientName: contact.name?.trim() || "",
    publicUrl,
  });
  try {
    await sendEmail({
      to: recipientEmail,
      subject: email.subject,
      text: email.text,
      html: email.html,
      replyTo: access.email || undefined,
      from: tenantFrom(sub),
      meter: { subAccountId },
    });
  } catch (err) {
    console.error("[quotes/send] Resend send failed", err);
    const message =
      err instanceof Error ? err.message : "Email provider rejected the send";
    return NextResponse.json(
      { error: `Send failed: ${message}` },
      { status: 502 },
    );
  }

  // viewedAt = null on re-send: each new token starts a fresh "opened yet?"
  // cycle.
  const wasResend = quote.status !== "draft";
  try {
    await quoteRef.update({
      status: "sent",
      sentAt: FieldValue.serverTimestamp(),
      viewedAt: null,
      publicTokenHash: hash,
      updatedAt: FieldValue.serverTimestamp(),
      ...(paymentLinkUpdate ?? {}),
    });
  } catch (err) {
    console.error("[quotes/send] quote lifecycle write failed", err);
  }

  await recordQuoteActivity(quote, "quote_sent", {
    extra: wasResend ? "re-sent" : null,
  });
  await fireQuoteTrigger(quote, "quote_sent");
  runAfterResponse(() => emitQuoteWebhook(quote, "quote_sent"));

  return NextResponse.json({
    ok: true,
    sentTo: recipientEmail,
    paymentLinkUrl: paymentLinkUpdate?.paymentLinkUrl ?? quote.paymentLinkUrl ?? null,
  });
}
