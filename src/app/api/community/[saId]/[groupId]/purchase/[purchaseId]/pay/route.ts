import "server-only";

import { NextResponse } from "next/server";
import Stripe from "stripe";

import { getAdminDb } from "@/lib/firebase/admin";
import { requireMemberApi } from "@/lib/community/member-context";
import { mapStripeSessionError } from "@/lib/stripe/session-error";
import {
  createCheckoutSessionForSubAccount,
  getSubAccountStripe,
  StripeConnectionError,
} from "@/lib/stripe/sub-account-client";
import { createPendingOrder } from "@/lib/server/orders-service";
import {
  checkCheckoutRateLimit,
  clientIpFrom,
} from "@/lib/checkout/rate-limit";
import type { Purchase } from "@/types/community";
import type { OrderLineItem } from "@/types/orders";

export const dynamic = "force-dynamic";

/**
 * Member pays a pending community purchase by card. Auth is the member
 * magic-link session (members are contacts, not Firebase users).
 *
 * The purchase must belong to the caller, and the amount comes from the
 * purchase doc, never the request. On payment the reconciler calls
 * `markPurchasePaidServerSide()`, same as staff "Mark paid", so access and
 * webhooks behave identically.
 */

function fail(message: string, status = 400): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ saId: string; groupId: string; purchaseId: string }> },
) {
  const { saId, groupId, purchaseId } = await ctx.params;

  const rate = checkCheckoutRateLimit(clientIpFrom(request));
  if (!rate.ok) {
    return NextResponse.json(
      { error: "Too many attempts. Please try again shortly." },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSec) } },
    );
  }

  const access = await requireMemberApi(saId);
  if (access.kind === "error") {
    return NextResponse.json({ error: access.message }, { status: access.status });
  }

  const db = getAdminDb();
  const ref = db.doc(
    `subAccounts/${saId}/communityGroups/${groupId}/purchases/${purchaseId}`,
  );
  const snap = await ref.get();
  if (!snap.exists) return fail("Purchase not found.", 404);

  const purchase = { id: snap.id, ...(snap.data() as Omit<Purchase, "id">) };

  // A member may only pay their own purchase.
  if (purchase.memberId !== access.member.id) {
    return fail("Purchase not found.", 404);
  }
  if (purchase.status === "paid") {
    return fail("This purchase is already paid.", 409);
  }
  if (purchase.status !== "pending") {
    return fail("This purchase is no longer payable.", 409);
  }
  if (!purchase.amountCents || purchase.amountCents <= 0) {
    return fail("This purchase has nothing to pay.", 409);
  }

  const subSnap = await db.doc(`subAccounts/${saId}`).get();
  if (subSnap.data()?.paymentsEnabledByAgency !== true) {
    return fail("Card payment isn't available here.", 409);
  }

  // Fail early with a specific message if Stripe or its webhook isn't set up,
  // instead of a generic session-create error.
  try {
    await getSubAccountStripe(saId);
  } catch (err) {
    if (err instanceof StripeConnectionError) {
      console.error(`[community/pay] connection unusable sa=${saId} code=${err.code}`);
      return fail(
        "Card payment is temporarily unavailable. Please try the other payment option.",
        503,
      );
    }
    throw err;
  }

  const label =
    purchase.scope === "group" ? "Group access" : "Course access";
  const currency = (purchase.currency || "USD").toLowerCase();
  const lineItems: OrderLineItem[] = [
    {
      productId: null,
      name: label,
      description: "",
      unitPriceCents: purchase.amountCents,
      quantity: 1,
      isBump: false,
    },
  ];

  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
  let session: Stripe.Checkout.Session;
  try {
    session = await createCheckoutSessionForSubAccount({
      subAccountId: saId,
      params: {
        mode: "payment",
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency,
              unit_amount: purchase.amountCents,
              product_data: { name: label },
            },
          },
        ],
        success_url: `${base}/c/${saId}?paid=1`,
        cancel_url: `${base}/c/${saId}?cancelled=1`,
        metadata: {
          leadstackSubAccountId: saId,
          leadstackCommunityGroupId: groupId,
          leadstackPurchaseId: purchaseId,
        },
      },
    });
  } catch (err) {
    const mapped = mapStripeSessionError(err);
    console.error(
      `[community/pay] stripe session failed purchase=${purchaseId} — ${mapped.logDetail}`,
    );
    return fail(mapped.buyerMessage, mapped.status);
  }

  if (!session.url) return fail("Card payment is temporarily unavailable.", 502);

  try {
    await createPendingOrder({
      agencyId: purchase.agencyId,
      subAccountId: saId,
      // Link the contact so the order shows on their timeline.
      contactId: access.member.contactId ?? null,
      checkoutPageId: null,
      communityGroupId: groupId,
      purchaseId,
      source: "community",
      currency,
      lineItems,
      stripeCheckoutSessionId: session.id,
      livemode: session.livemode,
      buyerEmail: access.member.email ?? null,
      buyerName: access.member.displayName ?? null,
      attribution: null,
    });
  } catch (err) {
    // Without the order row the webhook can't grant access, so the member would
    // pay and stay locked out. Refuse instead.
    console.error(`[community/pay] pending order write failed purchase=${purchaseId}`, err);
    return fail("Card payment is temporarily unavailable.", 500);
  }

  return NextResponse.json({ url: session.url });
}
