"use client";

import { useEffect, useState } from "react";
import { doc, getDoc } from "firebase/firestore";
import { getFirebaseDb } from "@/lib/firebase/client";

/**
 * Agency-owner uid from appConfig/main (readable by any active member).
 *
 * Used to hide the owner's membership row from client-facing rosters and
 * pickers. The owner has a real row in every sub-account (it powers their
 * switcher), but a client shouldn't see their provider in the team list,
 * remove them, or pick them as a booking host.
 *
 * Fails open: null while loading or on error, and consumers treat null as
 * "filter nothing". A roster must never blank out on a blip.
 */
export function useAgencyOwnerUid(): string | null {
  const [ownerUid, setOwnerUid] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getDoc(doc(getFirebaseDb(), "appConfig", "main"))
      .then((snap) => {
        if (cancelled) return;
        const v = snap.data()?.firstAgencyOwnerUid;
        setOwnerUid(typeof v === "string" && v.length > 0 ? v : null);
      })
      .catch(() => {
        /* fail open */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return ownerUid;
}
