"use client";

import { useEffect, useState } from "react";
import { subscribeToTasks } from "@/lib/firestore/tasks";
import { toDate } from "@/lib/format";
import { useAuth } from "@/hooks/use-auth";

/**
 * Incomplete tasks due today or overdue, for the sidebar Tasks badge. The
 * sub-account is passed in (useActiveSubAccountId) because consumers render
 * above SubAccountProvider, where the context is always null.
 */
export function useDueTodayCount(
  subAccountId: string | null,
  agencyId: string | null,
): number {
  const { user } = useAuth();
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!user || !subAccountId || !agencyId) {
      setCount(0);
      return;
    }
    const unsub = subscribeToTasks(
      { agencyId, subAccountId },
      (tasks) => {
        const now = Date.now();
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const nextDay = new Date(today);
        nextDay.setDate(nextDay.getDate() + 1);
        let n = 0;
        for (const t of tasks) {
          if (t.completed) continue;
          const d = toDate(t.dueAt);
          if (!d) continue;
          if (d.getTime() < nextDay.getTime() || d.getTime() < now) {
            n += 1;
          }
        }
        setCount(n);
      },
    );
    return () => unsub();
  }, [user, subAccountId, agencyId]);

  return count;
}
