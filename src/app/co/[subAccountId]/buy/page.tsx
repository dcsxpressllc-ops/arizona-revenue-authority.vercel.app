import PublicCheckoutPage, {
  generateMetadata as checkoutMetadata,
} from "@/app/co/[subAccountId]/[slug]/page";

export const dynamic = "force-dynamic";

/**
 * The "buy" folder (express buy links) shadows a checkout page whose slug is
 * "buy", which existed before the slug was reserved. Render that page here
 * so its link keeps working.
 */

type Params = Promise<{ subAccountId: string }>;

export async function generateMetadata({ params }: { params: Params }) {
  const { subAccountId } = await params;
  return checkoutMetadata({ params: Promise.resolve({ subAccountId, slug: "buy" }) });
}

export default async function LegacyBuyCheckoutPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { subAccountId } = await params;
  return PublicCheckoutPage({
    params: Promise.resolve({ subAccountId, slug: "buy" }),
    searchParams,
  });
}
