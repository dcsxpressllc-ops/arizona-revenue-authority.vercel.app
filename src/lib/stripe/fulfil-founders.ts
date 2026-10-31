// Hello world
import "server-only";

export interface FoundersFulfilmentInput {
  purchaseId: string;
  rail: string;
  email: string;
  buyerName: string | null;
  amountPaidCents: number | null;
  stripeCustomerId: string | null;
  paymentIntentId: string | null;
  tosConsent: string | null;
  metadata: Record<string, string | undefined>;
  address: {
    city?: string | null;
    country?: string | null;
    state?: string | null;
    postal_code?: string | null;
  } | null;
  claimUrl: string | null;
}

export type FoundersFulfilmentOutcome =
  | { status: "fulfilled" }
  | { status: "duplicate" }
  | { status: "skipped"; reason: "no_email" };

export async function fulfilFoundersPurchase(
  _input: FoundersFulfilmentInput,
): Promise<FoundersFulfilmentOutcome> {
  return { status: "skipped", reason: "no_email" };
}
