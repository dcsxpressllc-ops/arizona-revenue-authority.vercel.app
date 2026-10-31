import { isLicenseRevoked } from "@/lib/license/license";
import { LicenseLockScreen } from "@/components/license/lock-screen";
import { DashboardAppShell } from "@/components/dashboard/app-shell";

// Runs the license gate (lib/license/license.ts; fail-open, only bites in the
// provisional window) before the client chrome.
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (await isLicenseRevoked()) {
    return <LicenseLockScreen />;
  }
  return <DashboardAppShell>{children}</DashboardAppShell>;
}
