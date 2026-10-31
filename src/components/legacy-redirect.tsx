"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/use-auth";

/**
 * Redirects a legacy single-tenant path (/contacts, /dashboard/settings) to the
 * same path under the user's first sub-account (/sa/{first}/contacts). Still hit
 * by hard-coded links such as the navbar's "Go to Dashboard". Users with no
 * memberships go to /agency.
 */
export function LegacyRedirect({
  /** Appended after /sa/{subAccountId}, e.g. "/contacts/abc". */
  toSubPath,
}: {
  toSubPath: string;
}) {
  const router = useRouter();
  const { loading, memberships, agencyRole } = useAuth();

  useEffect(() => {
    if (loading) return;
    const target = memberships[0];
    if (!target) {
      // No sub-accounts: owners create one on /agency, everyone else sees the no-access state.
      router.replace("/agency");
      return;
    }
    // Owner on bare /dashboard with no current sub-account gets the picker.
    if (agencyRole === "owner" && toSubPath === "/dashboard") {
      router.replace("/agency");
      return;
    }
    router.replace(`/sa/${target.subAccountId}${toSubPath}`);
  }, [loading, memberships, agencyRole, toSubPath, router]);

  return (
    <div className="flex h-full items-center justify-center p-12">
      <div className="space-y-2 text-center">
        <div className="mx-auto h-6 w-24 animate-pulse rounded bg-muted" />
        <p className="text-xs text-muted-foreground">Loading…</p>
      </div>
    </div>
  );
}
