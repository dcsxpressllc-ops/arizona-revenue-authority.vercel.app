import type Stripe from "stripe";
import { getAdminDb } from "@/lib/firebase/admin";
import { fulfilFoundersPurchase } from "@/lib/stripe/fulfil-founders";
import {
  SUB_ACCOUNT_CHARGE_KIND,
  SUB_ACCOUNT_PLAN_KIND,
  handleSubAccountChargeCheckoutCompleted,
  handleSubAccountPlanCheckoutCompleted,
  handleSubAccountSubscriptionEvent,
} from "@/lib/server/billing-service";
import {
  CLOUD_KIND,
  handleCloudCheckoutCompleted,
  handleCloudSubscriptionEvent,
} from "@/lib/cloud/fulfil";
import type { SubscriptionStatus } from "@/types";

export async function handleCheckoutCompleted(
  session: Stripe.Checkout.Session
) {
  // Founders purchase: anonymous one-time, no uid in metadata. Routed by
  // metadata.kind so the legacy subscription flow is unaffected.
  if (session.metadata?.kind === "founders") {
    await handleFoundersCheckout(session);
    return;
  }

  // Cloud subscription (a no-op stub in template clones). Routed strictly by
  // metadata.kind; a buyer's Stripe never produces kind="cloud".
  if (session.metadata?.kind === CLOUD_KIND) {
    await handleCloudCheckoutCompleted(session);
    return;
  }

  // A client paying for their sub-account plan.
  if (session.metadata?.kind === SUB_ACCOUNT_PLAN_KIND) {
    await handleSubAccountPlanCheckoutCompleted(session);
    return;
  }

  // One-time agency-to-client charge (mode: "payment").
  if (session.metadata?.kind === SUB_ACCOUNT_CHARGE_KIND) {
    await handleSubAccountChargeCheckoutCompleted(session);
    return;
  }

  // Legacy subscription flow; needs the uid stamped at checkout creation.
  const uid = session.metadata?.uid;
  if (!uid) {
    console.error("No uid found in checkout session metadata");
    return;
  }

  await getAdminDb()
    .collection("users")
    .doc(uid)
    .update({
      stripeCustomerId: session.customer as string,
      subscriptionStatus: "active" as SubscriptionStatus,
      subscriptionPriceId: session.metadata?.priceId ?? null,
      updatedAt: new Date(),
    });
}

async function handleFoundersCheckout(session: Stripe.Checkout.Session) {
  const sessionId = session.id;
  // Only fulfil once the money has landed. Delayed methods (BNPL, bank debits)
  // complete with payment_status "unpaid" and send async_payment_succeeded
  // later, which is also routed here, so the purchase is recorded once.
  if (session.payment_status !== "paid") {
    console.log(
      `[founders] Session ${sessionId} completed with payment_status=${session.payment_status} — waiting for async payment`
    );
    return;
  }
  const email = session.customer_details?.email ?? session.customer_email;
  if (!email) {
    console.error(
      `[founders] Session ${sessionId} completed without a buyer email — cannot send welcome`
    );
    return;
  }

  // Map the session onto the rail-agnostic fulfilment input. The real work is in
  // lib/stripe/fulfil-founders.ts so another payment rail can share it.
  const meta = (session.metadata ?? {}) as Record<string, string | undefined>;

  // Same /thank-you?session_id=...&t=... URL as success_url, so the welcome email
  // doubles as a recovery link if they closed the tab before claiming. Null if
  // either piece is missing; the email then says to chat us.
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  const claimToken = meta.claimToken;
  const claimUrl =
    appUrl && typeof claimToken === "string" && claimToken.length > 0
      ? `${appUrl}/thank-you?session_id=${encodeURIComponent(sessionId)}&t=${encodeURIComponent(claimToken)}`
      : null;

  await fulfilFoundersPurchase({
    purchaseId: sessionId,
    rail: "stripe",
    email,
    buyerName: session.customer_details?.name ?? null,
    amountPaidCents:
      typeof session.amount_total === "number" ? session.amount_total : null,
    stripeCustomerId: (session.customer as string | null) ?? null,
    paymentIntentId:
      typeof session.payment_intent === "string"
        ? session.payment_intent
        : (session.payment_intent?.id ?? null),
    tosConsent: session.consent?.terms_of_service ?? null,
    metadata: meta,
    address: session.customer_details?.address ?? null,
    claimUrl,
  });
}
export async function handleSubscriptionUpdated(
  subscription: Stripe.Subscription
) {
  // Plan subscriptions never touch the legacy users/{uid} lookup below.
  if (subscription.metadata?.kind === SUB_ACCOUNT_PLAN_KIND) {
    await handleSubAccountSubscriptionEvent(subscription, { deleted: false });
    return;
  }

  // Cloud subscriptions: returns true only if it owned the event. The template
  // stub always returns false, so the legacy path below still runs.
  if (await handleCloudSubscriptionEvent(subscription, { deleted: false })) {
    return;
  }

  const customerId = subscription.customer as string;

  const usersSnapshot = await getAdminDb()
    .collection("users")
    .where("stripeCustomerId", "==", customerId)
    .limit(1)
    .get();

  if (usersSnapshot.empty) {
    console.error(`No user found for Stripe customer ${customerId}`);
    return;
  }

  const userDoc = usersSnapshot.docs[0];
  await userDoc.ref.update({
    subscriptionStatus: subscription.status as SubscriptionStatus,
    updatedAt: new Date(),
  });
}

export async function handleSubscriptionDeleted(
  subscription: Stripe.Subscription
) {
  if (subscription.metadata?.kind === SUB_ACCOUNT_PLAN_KIND) {
    await handleSubAccountSubscriptionEvent(subscription, { deleted: true });
    return;
  }

  if (await handleCloudSubscriptionEvent(subscription, { deleted: true })) {
    return;
  }

  const customerId = subscription.customer as string;

  const usersSnapshot = await getAdminDb()
    .collection("users")
    .where("stripeCustomerId", "==", customerId)
    .limit(1)
    .get();

  if (usersSnapshot.empty) {
    console.error(`No user found for Stripe customer ${customerId}`);
    return;
  }

  const userDoc = usersSnapshot.docs[0];
  await userDoc.ref.update({
    subscriptionStatus: "inactive" as SubscriptionStatus,
    updatedAt: new Date(),
  });
}
