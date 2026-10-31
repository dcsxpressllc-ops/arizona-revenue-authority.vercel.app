"use client";

import { useEffect, useState } from "react";
import { subscribeToConversations } from "@/lib/firestore/conversations";
import { useAuth } from "@/hooks/use-auth";

/**
 * Conversations with unread inbound messages, for the sidebar, PWA tab bar and
 * app-icon badges. The sub-account is passed in (useActiveSubAccountId)
 * because every consumer renders above SubAccountProvider, where the context
 * is null.
 */
export function useUnreadConversationsCount(
  subAccountId: string | null,
): number {
  const { user } = useAuth();
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!user || !subAccountId) {
      setCount(0);
      return;
    }
    const unsub = subscribeToConversations(subAccountId, (rows) => {
      setCount(rows.filter((c) => (c.unreadCount ?? 0) > 0).length);
    });
    return () => unsub();
  }, [user, subAccountId]);

  return count;
}
