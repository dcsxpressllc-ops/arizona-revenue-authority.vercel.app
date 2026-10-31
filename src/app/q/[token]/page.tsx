import { notFound } from "next/navigation";
import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { hashQuoteToken, verifyQuoteToken } from "@/lib/quotes/token";
import { isQuoteExpired } from "@/lib/quotes/calc";
import { emitQuoteWebhook, recordQuoteActivity } from "@/lib/quotes/lifecycle";
import { PublicQuoteView } from "@/components/quotes/public-quote-view";
import { LogoMark } from "@/components/brand/logo-mark";
import type { Quote } from "@/types/quotes";

export const dynamic = "force-dynamic";

/**
 * Public quote page, server-rendered so the document is complete before JS
 * loads (only Accept/Decline is interactive). Token is HMAC-verified and must
 * match the quote's publicTokenHash, otherwise 404. The first valid load of a
 * "sent" quote flips it to "viewed" once.
 */

interface PageProps {
  params: Promise<{ token: string }>;
}

export default async function PublicQuotePage({ params }: PageProps) {
  const { token } = await params;

  const verified = verifyQuoteToken(token);
  if (!verified) notFound();

  const db = getAdminDb();
  const quoteSnap = await db.collection("quotes").doc(verified.quoteId).get();
  if (!quoteSnap.exists) notFound();

  const quote = {
    id: quoteSnap.id,
    ...(quoteSnap.data() as Omit<Quote, "id">),
  };

  // The hash is from the most recent send, so a mismatch is a leaked old or
  // forged token. Behave exactly like "not found".
  if (quote.publicTokenHash !== hashQuoteToken(token)) {
    notFound();
  }

  // Best-effort; a failed write mustn't break the page. Views don't fire a
  // workflow trigger, they're too noisy a signal.
  if (quote.status === "sent" && !quote.viewedAt) {
    try {
      await quoteSnap.ref.update({
        status: "viewed",
        viewedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      // Match what we just wrote without a refetch.
      quote.status = "viewed";
      await recordQuoteActivity(quote, "quote_viewed");
      void emitQuoteWebhook(quote, "quote_viewed");
    } catch (err) {
      console.error("[/q/[token]] viewedAt update failed", err);
    }
  }

  // Fall back to a placeholder if the sub-account doc is gone.
  const subSnap = await db
    .doc(`subAccounts/${quote.subAccountId}`)
    .get();
  const subData = subSnap.exists ? (subSnap.data() ?? {}) : {};
  const businessName =
    (subData.name as string | undefined) || "Your business";
  const businessLogoUrl =
    typeof subData.logoUrl === "string" &&
    /^https?:\/\/.+/i.test(subData.logoUrl as string)
      ? (subData.logoUrl as string)
      : null;

  const expired = isQuoteExpired(quote);

  // Card pay only with the agency gate on AND a Stripe connection that can
  // confirm payments. ready === false means the webhook isn't set up, so a
  // payment would never mark the invoice paid. PayPal is unaffected.
  const stripeMeta = subData.stripeConnectionMeta as
    | { ready?: boolean }
    | null
    | undefined;
  const cardPayEnabled =
    subData.paymentsEnabledByAgency === true && stripeMeta?.ready === true;

  return (
    <div className="flex min-h-screen flex-col bg-muted/30">
      <header className="border-b bg-background">
        <div className="container mx-auto flex h-14 items-center gap-2 px-4 text-sm">
          {businessLogoUrl ? (
            // Sub-account brand override. Capped at 24px tall so it sits
            // cleanly in the chrome bar.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={businessLogoUrl}
              alt={businessName}
              className="h-6 w-auto max-w-[140px] object-contain"
            />
          ) : (
            <LogoMark size={18} idSuffix="-public-quote" />
          )}
          <span className="font-medium">{businessName}</span>
          <span className="text-muted-foreground">·</span>
          <span className="font-mono text-xs text-muted-foreground">
            {quote.quoteNumber}
          </span>
        </div>
      </header>

      <main className="container mx-auto flex-1 px-4 py-10">
        <PublicQuoteView
          quote={serializeQuote(quote)}
          token={token}
          businessName={businessName}
          businessLogoUrl={businessLogoUrl}
          expired={expired}
          cardPayEnabled={cardPayEnabled}
        />
      </main>

      <footer className="border-t bg-background py-4">
        <div className="container mx-auto px-4 text-center text-[11px] text-muted-foreground">
          {quote.kind === "invoice" ? "Invoice" : "Quote"} sent via LeadStack.
          Reply to the email to reach {businessName}.
        </div>
      </footer>
    </div>
  );
}

/** Quote with Timestamps as epoch ms so it can be passed to a client component. */
type SerializableQuote = Omit<
  Quote,
  | "createdAt"
  | "updatedAt"
  | "sentAt"
  | "viewedAt"
  | "acceptedAt"
  | "declinedAt"
  | "paidAt"
  | "validUntil"
  | "convertedFromQuoteAt"
  | "paymentLinkMintedAt"
> & {
  createdAt: number | null;
  updatedAt: number | null;
  sentAt: number | null;
  viewedAt: number | null;
  acceptedAt: number | null;
  declinedAt: number | null;
  paidAt: number | null;
  validUntil: number | null;
  convertedFromQuoteAt: number | null;
  paymentLinkMintedAt: number | null;
};

function serializeQuote(quote: Quote): SerializableQuote {
  return {
    ...quote,
    createdAt: tsMillis(quote.createdAt),
    updatedAt: tsMillis(quote.updatedAt),
    sentAt: tsMillis(quote.sentAt),
    viewedAt: tsMillis(quote.viewedAt),
    acceptedAt: tsMillis(quote.acceptedAt),
    declinedAt: tsMillis(quote.declinedAt),
    paidAt: tsMillis(quote.paidAt),
    validUntil: tsMillis(quote.validUntil),
    convertedFromQuoteAt: tsMillis(quote.convertedFromQuoteAt),
    paymentLinkMintedAt: tsMillis(quote.paymentLinkMintedAt),
    // Older docs have no kind.
    kind: quote.kind ?? "quote",
  };
}

function tsMillis(value: unknown): number | null {
  if (!value) return null;
  const v = value as { toMillis?: () => number; seconds?: number };
  if (typeof v.toMillis === "function") return v.toMillis();
  if (typeof v.seconds === "number") return v.seconds * 1000;
  return null;
}

export type { SerializableQuote };
