import { POST as checkoutSessionPOST } from "@/app/api/co/[subAccountId]/[slug]/session/route";

export const dynamic = "force-dynamic";

/**
 * Session endpoint for a checkout page slugged "buy" (created before the slug
 * was reserved): the express buy-link folder shadows its usual path.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ subAccountId: string }> },
) {
  const { subAccountId } = await ctx.params;
  return checkoutSessionPOST(request, {
    params: Promise.resolve({ subAccountId, slug: "buy" }),
  });
}
