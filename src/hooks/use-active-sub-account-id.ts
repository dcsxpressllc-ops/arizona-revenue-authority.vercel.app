"use client";

import { usePathname } from "next/navigation";
import { useAuth } from "@/hooks/use-auth";

/**
 * Active sub-account for components mounted above SubAccountProvider (sidebar,
 * PWA tab bar and badge, Cmd+K palette all live in (dashboard)/layout.tsx).
 * useOptionalSubAccount() is always null there, so they'd silently fall back
 * to memberships[0] and show the wrong sub-account.
 *
 * Derives the id from /sa/[subAccountId]/... instead, falling back to
 * memberships[0] only on agency-level pages. agencyId comes from the matching
 * membership, else the auth claim (one agency per deployment).
 */
export function useActiveSubAccountId(): {
  subAccountId: string | null;
  agencyId: string | null;
} {
  const pathname = usePathname();
  const { memberships, agencyId: claimAgencyId } = useAuth();

  const fromPath = pathname.match(/^\/sa\/([^/]+)/)?.[1] ?? null;
  const subAccountId = fromPath ?? memberships[0]?.subAccountId ?? null;
  const membership =
    memberships.find((m) => m.subAccountId === subAccountId) ?? null;
  const agencyId =
    membership?.agencyId ?? claimAgencyId ?? memberships[0]?.agencyId ?? null;

  return { subAccountId, agencyId };
}
