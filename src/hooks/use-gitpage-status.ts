"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { doc, onSnapshot, type Timestamp } from "firebase/firestore";
import { getFirebaseDb } from "@/lib/firebase/client";

/**
 * Activation gate. Mainly driven by whether GITPAGE_API_KEY is set: a pasted
 * key is trusted. The heartbeat's email-based subscription check is only
 * telemetry because the gitpage email often differs from the agency owner's.
 * An invalid key surfaces when the build route's 401 handler sets
 * `subscribe-needed` with lastError "401_invalid_api_key".
 */
export type GitpageGateState =
  | { kind: "unknown" } // first load, no doc yet: render normally
  | { kind: "ready" } // operator has pasted a key
  | { kind: "subscribe-needed"; lastError: string | null };

interface GitpageStatusDoc {
  agency?: boolean;
  hasApiKey?: boolean;
  lastCheckedAt?: Timestamp | null;
  lastError?: string | null;
  /** Set when a build POST is accepted (202). Diagnostic only. */
  lastBuildAcceptedAt?: Timestamp | null;
}

/** Derived gate state from system/gitpageStatus. Read-only; mutate via the API. */
export function useGitpageStatus() {
  const [doc_, setDoc] = useState<GitpageStatusDoc | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const ref = doc(getFirebaseDb(), "system/gitpageStatus");
    const unsub = onSnapshot(
      ref,
      (snap) => {
        setDoc(snap.exists() ? (snap.data() as GitpageStatusDoc) : null);
        setHydrated(true);
      },
      () => setHydrated(true),
    );
    return () => unsub();
  }, []);

  const state = useMemo<GitpageGateState>(() => {
    if (!hydrated) return { kind: "unknown" };
    if (!doc_) return { kind: "unknown" };
    if (doc_.hasApiKey === true) return { kind: "ready" };
    return {
      kind: "subscribe-needed",
      lastError: doc_.lastError ?? null,
    };
  }, [hydrated, doc_]);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/agency/refresh-gitpage-status", {
      method: "POST",
    });
    return res.ok;
  }, []);

  return { state, refresh, hydrated };
}

/** UTM-tagged subscription URL, shared with the banners. */
export const GITPAGE_SUBSCRIBE_URL =
  "https://www.gitpage.site/?showPricing=true&utm_source=leadstack&utm_medium=in_app";
