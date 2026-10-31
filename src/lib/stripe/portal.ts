"use server";

import { requireAdminAction } from "@/lib/auth/require-admin";
import { getStripeServer } from "./server";

/** Billing Portal URL, or null if the customer has no Stripe record yet. */
export async function createBillingPortalSession(
  stripeCustomerId: string,
): Promise<string | null> {
  if (!stripeCustomerId) return null;
  await requireAdminAction();
  const stripe = getStripeServer();
  const session = await stripe.billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/settings`,
  });
  return session.url;
}
