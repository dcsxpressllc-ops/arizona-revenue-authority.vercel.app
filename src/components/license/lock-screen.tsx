import { ShieldAlert } from "lucide-react";

/**
 * Shown instead of the dashboard/auth layouts when the license is flagged invalid
 * during the provisional window (lib/license/license.ts). Unbranded on purpose
 * since it ships white-label. Public forms, booking pages and the API keep working.
 */
export function LicenseLockScreen() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-6">
      <div className="w-full max-w-md space-y-4 rounded-2xl border bg-card p-8 text-center shadow-sm">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
          <ShieldAlert className="h-6 w-6 text-destructive" />
        </div>
        <h1 className="text-lg font-semibold tracking-tight">
          License verification failed
        </h1>
        <p className="text-sm text-muted-foreground">
          This deployment&apos;s software license could not be verified and
          dashboard access has been suspended. If you believe this is a
          mistake, contact the vendor who supplied your license to restore
          access.
        </p>
      </div>
    </div>
  );
}
