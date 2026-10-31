"use client";

import { useEffect, useState } from "react";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { useSubAccount } from "@/context/sub-account-context";
import { getFirebaseDb } from "@/lib/firebase/client";
import type { BroadcastDoc } from "@/types";

/**
 * Optional "which broadcast" picker for the email.opened / email.clicked
 * triggers. Absent = any broadcast. Lists the workspace's broadcasts newest
 * first (sorted in memory; no composite index).
 */
export function BroadcastTriggerFilter({
  value,
  onChange,
}: {
  value: string | null | undefined;
  onChange: (broadcastId: string | null) => void;
}) {
  const { subAccountId } = useSubAccount();
  const [broadcasts, setBroadcasts] = useState<BroadcastDoc[]>([]);

  useEffect(() => {
    if (!subAccountId) return;
    return onSnapshot(
      query(
        collection(getFirebaseDb(), "broadcasts"),
        where("subAccountId", "==", subAccountId),
      ),
      (snap) => {
        const list = snap.docs.map((d) => d.data() as BroadcastDoc);
        list.sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));
        setBroadcasts(list.slice(0, 100));
      },
      () => setBroadcasts([]),
    );
  }, [subAccountId]);

  const current = value ?? "";
  const known = broadcasts.some((b) => b.id === current);

  return (
    <>
      <select
        value={current}
        onChange={(e) => onChange(e.target.value || null)}
        className="border-input bg-background mt-2 h-9 w-full rounded-md border px-2 text-sm [&_option]:bg-background [&_option]:text-foreground"
      >
        <option value="">Any broadcast</option>
        {broadcasts.map((b) => (
          <option key={b.id} value={b.id}>
            {b.templateName}
            {b.subjectPreview ? ` — ${b.subjectPreview}` : ""}
          </option>
        ))}
        {current && !known && (
          <option value={current}>Selected broadcast (no longer listed)</option>
        )}
      </select>
      <p className="text-muted-foreground mt-1.5 text-xs">
        Fires once per contact, on their first open or click. Opens and clicks
        are only reported when tracking is on for the sending domain (Settings
        → Email sending domain).
      </p>
    </>
  );
}

function toMillis(v: unknown): number {
  if (!v) return 0;
  const maybe = v as { toMillis?: () => number; seconds?: number };
  if (typeof maybe.toMillis === "function") return maybe.toMillis();
  if (typeof maybe.seconds === "number") return maybe.seconds * 1000;
  return 0;
}
