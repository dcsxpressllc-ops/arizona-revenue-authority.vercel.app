import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { getAdminDb } from "@/lib/firebase/admin";
import { resolveSubdomain } from "@/lib/funnels/subdomains";
import FunnelLandingPage, {
  generateMetadata as funnelMetadata,
} from "@/app/fn/[subAccountId]/[slug]/page";

export const dynamic = "force-dynamic";

/**
 * Internal target of the vanity-host rewrite (7dsummer.leadstack.dev/ to
 * /fnh/7dsummer). Resolves the claim, then renders the real funnel page
 * component with those params so there's one rendering path.
 * The claim stores the funnel ID, not the slug, so slug renames don't break
 * the vanity host; we read the funnel doc for the current slug.
 */

async function resolveParams(
  subdomain: string,
): Promise<{ subAccountId: string; slug: string } | null> {
  const claim = await resolveSubdomain(subdomain);
  if (!claim) return null;
  const snap = await getAdminDb()
    .doc(`subAccounts/${claim.subAccountId}/funnels/${claim.funnelId}`)
    .get();
  const slug = snap.data()?.slug as string | undefined;
  if (!slug) return null;
  return { subAccountId: claim.subAccountId, slug };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ subdomain: string }>;
}): Promise<Metadata> {
  const { subdomain } = await params;
  const resolved = await resolveParams(subdomain);
  if (!resolved) return { title: "Not found" };
  return funnelMetadata({ params: Promise.resolve(resolved) });
}

export default async function FunnelHostPage({
  params,
}: {
  params: Promise<{ subdomain: string }>;
}) {
  const { subdomain } = await params;
  const resolved = await resolveParams(subdomain);
  if (!resolved) notFound();
  return FunnelLandingPage({ params: Promise.resolve(resolved) });
}
