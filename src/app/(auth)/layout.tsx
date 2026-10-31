import { isLicenseRevoked } from "@/lib/license/license";
import { LicenseLockScreen } from "@/components/license/lock-screen";

// Login/signup lock with the dashboard while the license is flagged in the
// provisional window (lib/license/license.ts). Forms, booking and API stay up.
export default async function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (await isLicenseRevoked()) {
    return <LicenseLockScreen />;
  }
  return <>{children}</>;
}
