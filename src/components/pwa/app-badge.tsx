"use client";

import { useEffect } from "react";
import { useUnreadConversationsCount } from "@/hooks/use-unread-conversations";
import { useActiveSubAccountId } from "@/hooks/use-active-sub-account-id";

/**
 * Mirrors the unread count onto the installed app icon via the Badging API.
 * No-op where unsupported. Cleared on unmount (sign-out unmounts the layout) so
 * the badge can't outlive the session.
 */
export function AppBadge() {
  const { subAccountId } = useActiveSubAccountId();
  const unread = useUnreadConversationsCount(subAccountId);

  useEffect(() => {
    const nav = navigator as Navigator & {
      setAppBadge?: (n?: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    if (!nav.setAppBadge || !nav.clearAppBadge) return;
    if (unread > 0) {
      void nav.setAppBadge(unread).catch(() => {});
    } else {
      void nav.clearAppBadge().catch(() => {});
    }
    return () => {
      void nav.clearAppBadge?.().catch(() => {});
    };
  }, [unread]);

  return null;
}
