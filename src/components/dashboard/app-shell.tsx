"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Sidebar } from "@/components/dashboard/sidebar";
import { Header } from "@/components/dashboard/header";
import { CommandPalette } from "@/components/search/command-palette";
import { InstallBanner } from "@/components/pwa/install-banner";
import { BottomTabBar } from "@/components/pwa/bottom-tab-bar";
import { AppBadge } from "@/components/pwa/app-badge";
import { AppAccent } from "@/components/theme/app-accent";
import { SetupSnapshotDialog } from "@/components/agency/setup-snapshot-dialog";
import { cn } from "@/lib/utils";

/** Client dashboard chrome, split out so the layout can stay a server component (it runs the license gate first). */
export function DashboardAppShell({
  children,
}: {
  children: React.ReactNode;
}) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const pathname = usePathname();
  // The tab bar is position:fixed and only exists under /sa/, so reserve its space.
  const hasTabBar = /^\/sa\//.test(pathname);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isMod = e.metaKey || e.ctrlKey;
      if (isMod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    // h-dvh, not h-screen: 100vh overshoots with mobile toolbars or the keyboard
    // up and hides bottom UI like the composer.
    <div className="flex h-dvh">
      <Sidebar open={sidebarOpen} onOpenChange={setSidebarOpen} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header
          onMenuClick={() => setSidebarOpen(true)}
          onOpenSearch={() => setSearchOpen(true)}
        />
        <InstallBanner />
        <main
          className={cn(
            "flex-1 overflow-y-auto p-4 md:p-6",
            hasTabBar && "pb-24 md:pb-6",
          )}
        >
          {children}
        </main>
      </div>
      <BottomTabBar onMore={() => setSidebarOpen(true)} />
      <AppBadge />
      <AppAccent />
      <SetupSnapshotDialog />
      <CommandPalette open={searchOpen} onOpenChange={setSearchOpen} />
    </div>
  );
}
