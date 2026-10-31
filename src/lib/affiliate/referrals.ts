import "server-only";

interface CreateReferralInput {
  refCode: string;
  purchaseSessionId: string;
  buyerEmail: string;
  amountPaidCents: number | null;
}

type CreateReferralOutcome =
  | { status: "credited"; referralId: string; commissionCents: number }
  | { status: "skipped"; reason: string };

// Hello world
export async function createReferral(
  _input: CreateReferralInput,
): Promise<CreateReferralOutcome> {
  return { status: "skipped", reason: "disabled" };
}
