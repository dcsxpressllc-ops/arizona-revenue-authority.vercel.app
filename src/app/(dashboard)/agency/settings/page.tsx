"use client";

import Link from "next/link";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { BrandingSection } from "@/components/agency/branding-section";
import { AppIconSection } from "@/components/agency/app-icon-section";
import { AppThemeSection } from "@/components/agency/app-theme-section";
import { MessagingSection } from "@/components/agency/messaging-section";
import { AiModelSection } from "@/components/agency/ai-model-section";
import { AgencyAssistantSection } from "@/components/agency/agency-assistant-section";
import { AgencyAiKbSection } from "@/components/agency/agency-ai-kb-section";
import { SeedDemoSection } from "@/components/agency/seed-demo-section";
import { CloudDomainSection } from "@/components/agency/cloud-domain-section";
import { PasswordSection } from "@/components/settings/password-section";
import { LANDING_VARIANT } from "@/config/landing";

export default function AgencySettingsPage() {
  const { agencyRole, loading } = useAuth();

  if (!loading && agencyRole !== "owner") {
    return (
      <div className="mx-auto w-full max-w-5xl rounded-2xl border bg-card p-8 text-center">
        <p className="text-sm text-muted-foreground">
          Only the agency owner can manage agency-level settings.
        </p>
        <Button
          variant="outline"
          size="sm"
          render={<Link href="/agency" />}
          className="mt-4"
        >
          Back to agency
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Agency-level configuration. These settings apply across every
          sub-account and the public landing page.
        </p>
      </div>

      <section className="flex items-center justify-between gap-4 rounded-2xl border bg-card p-5">
        <div>
          <h2 className="text-sm font-semibold">Guided setup</h2>
          <p className="text-xs text-muted-foreground">
            Optionally enter your remaining API keys in-app and have them written
            to Vercel for you — an alternative to editing environment variables
            by hand.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          render={<Link href="/agency/setup" />}
        >
          Open
        </Button>
      </section>

      {/* Cloud-hosted only; renders nothing unless NEXT_PUBLIC_CLOUD is set. */}
      <CloudDomainSection />

      <BrandingSection />

      {/* PWA home-screen icon. The Branding logo brands the pages, this brands the phone. */}
      <AppIconSection />

      <AppThemeSection />

      {/* Read-only: the shared env-var Twilio + Resend senders, i.e. what
          "agency-level" SMS/email resolves to. */}
      <MessagingSection />

      <AiModelSection />

      {/* Off by default: every reply spends OpenRouter credits. */}
      <AgencyAssistantSection />

      {/* KB review only renders in local dev; deployed instances have no
          source tree to write to. */}
      <AgencyAiKbSection />

      {/* Also on sub-account settings so it's reachable from either. Handles its own reauth. */}
      <PasswordSection />

      {LANDING_VARIANT === "leadstack" && <SeedDemoSection />}
    </div>
  );
}
