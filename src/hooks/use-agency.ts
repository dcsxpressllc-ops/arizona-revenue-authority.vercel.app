"use client";

import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { useAuth } from "@/hooks/use-auth";
import { getFirebaseDb } from "@/lib/firebase/client";
import { CUSTOM_BRAND } from "@/config/landing";
import type { AgencyDoc, AppTheme } from "@/types";

interface AgencySummary {
  /** Falls back to the deployment brand until hydrated. */
  name: string;
  /** When set, replaces the LeadStack chevron mark in the sidebar. */
  logoUrl: string | null;
  /** Null until set in Agency Settings. */
  supportEmail: string | null;
  /** Bare domain, no scheme. Null until set in Agency Settings. */
  primaryDomain: string | null;
  /** Null = deployment-mode default. */
  appTheme: AppTheme | null;
  /** Agency Assistant master switch. Off unless the doc has an explicit `true`. */
  agencyAssistantEnabled: boolean;
  /** Unset reads as "opus", matching deployments from before the picker. */
  agencyAssistantModel: "opus" | "sonnet";
  /** Don't render brand chrome until this is false. */
  loading: boolean;
}

interface AgencyData {
  name: string;
  logoUrl: string | null;
  supportEmail: string | null;
  primaryDomain: string | null;
  appTheme: AppTheme | null;
  agencyAssistantEnabled: boolean;
  agencyAssistantModel: "opus" | "sonnet";
}

/**
 * Live agency doc: drives dashboard chrome (sidebar logo, tab title) and the
 * Agency Settings branding form. Defaults before hydration so SSR matches the
 * first client paint.
 */
export function useAgency(): AgencySummary {
  const { agencyId } = useAuth();
  const [data, setData] = useState<AgencyData>({
    // Deployment brand, not the template name: shows in client-visible chrome before hydration.
    name: CUSTOM_BRAND.name,
    logoUrl: null,
    supportEmail: null,
    primaryDomain: null,
    appTheme: null,
    agencyAssistantEnabled: false,
    agencyAssistantModel: "opus",
  });
  const [loading, setLoading] = useState<boolean>(!!agencyId);

  useEffect(() => {
    if (!agencyId) {
      setLoading(false);
      return;
    }
    const ref = doc(getFirebaseDb(), `agencies/${agencyId}`);
    const unsub = onSnapshot(
      ref,
      (snap) => {
        if (snap.exists()) {
          const d = snap.data() as Partial<AgencyDoc>;
          setData({
            name: (d.name as string) || CUSTOM_BRAND.name,
            logoUrl: (d.logoUrl as string | null) ?? null,
            supportEmail: (d.supportEmail as string | null) ?? null,
            primaryDomain: (d.primaryDomain as string | null) ?? null,
            appTheme: (d.appTheme as AppTheme | null) ?? null,
            agencyAssistantEnabled: d.agencyAssistantEnabled === true,
            agencyAssistantModel:
              d.agencyAssistantModel === "sonnet" ? "sonnet" : "opus",
          });
        }
        setLoading(false);
      },
      () => setLoading(false),
    );
    return () => unsub();
  }, [agencyId]);

  return { ...data, loading };
}
