"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { doc, onSnapshot } from "firebase/firestore";
import { getFirebaseDb } from "@/lib/firebase/client";
import { useAuth } from "@/hooks/use-auth";
import type { SubAccountDoc, SubAccountRole } from "@/types";

export interface SubAccountContextValue {
  subAccountId: string;
  subAccount: SubAccountDoc | null;
  loading: boolean;
  /** Effective role here. Agency owners resolve to "admin". */
  myRole: SubAccountRole | null;
  isAdmin: boolean;
  /** Agency owner (not a client-level admin). */
  isAgencyOwner: boolean;
  agencyId: string | null;
  /** Prefix a dashboard path with the active sub-account, e.g. "/contacts" -> "/sa/abc123/contacts". Use for all in-app links. */
  saPath: (path: string) => string;
}

const SubAccountContext = createContext<SubAccountContextValue | undefined>(
  undefined,
);

export function SubAccountProvider({
  subAccountId,
  children,
}: {
  subAccountId: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const {
    user,
    agencyId: claimAgencyId,
    agencyRole,
    memberships,
    membershipsLoaded,
    loading: authLoading,
  } = useAuth();
  const [subAccount, setSubAccount] = useState<SubAccountDoc | null>(null);
  const [subLoading, setSubLoading] = useState(true);

  useEffect(() => {
    if (!user || !subAccountId) {
      setSubAccount(null);
      setSubLoading(false);
      return;
    }
    const unsub = onSnapshot(
      doc(getFirebaseDb(), "subAccounts", subAccountId),
      (snap) => {
        if (!snap.exists()) {
          setSubAccount(null);
          setSubLoading(false);
          return;
        }
        setSubAccount(snap.data() as SubAccountDoc);
        setSubLoading(false);
      },
      () => {
        setSubAccount(null);
        setSubLoading(false);
      },
    );
    return () => unsub();
  }, [user, subAccountId]);

  // Agency owners always pass.
  const ownerForThisAgency =
    agencyRole === "owner" &&
    !!subAccount &&
    !!claimAgencyId &&
    subAccount.agencyId === claimAgencyId;
  const membership = memberships.find((m) => m.subAccountId === subAccountId);
  const myRole: SubAccountRole | null = ownerForThisAgency
    ? "admin"
    : (membership?.role ?? null);
  const isAdmin = ownerForThisAgency || myRole === "admin";

  // Only redirect once auth and sub-account snapshots resolve and neither the
  // owner shortcut nor a membership covers us.
  useEffect(() => {
    if (authLoading || subLoading) return;
    // authLoading goes false before memberships land; without this a refresh
    // would bounce a valid collaborator against an empty list.
    if (!membershipsLoaded) return;
    if (!user) return;
    if (!subAccount) return; // sub-account doesn't exist; let the page handle it
    if (ownerForThisAgency) return;
    if (membership) return;
    router.replace("/agency?error=no-access");
  }, [
    authLoading,
    subLoading,
    membershipsLoaded,
    user,
    subAccount,
    ownerForThisAgency,
    membership,
    router,
  ]);

  const value: SubAccountContextValue = {
    subAccountId,
    subAccount,
    // myRole/isAdmin derive from membership, so stay loading until it arrives.
    loading: authLoading || subLoading || !membershipsLoaded,
    myRole,
    isAdmin,
    isAgencyOwner: ownerForThisAgency,
    agencyId: subAccount?.agencyId ?? claimAgencyId,
    saPath: (path: string) => {
      if (!path.startsWith("/")) return path;
      return `/sa/${subAccountId}${path}`;
    },
  };

  return (
    <SubAccountContext.Provider value={value}>
      {children}
    </SubAccountContext.Provider>
  );
}

export function useSubAccount(): SubAccountContextValue {
  const ctx = useContext(SubAccountContext);
  if (!ctx) {
    throw new Error("useSubAccount must be used within a SubAccountProvider");
  }
  return ctx;
}

/** useSubAccount() that returns null without a provider, for components shared with agency-level pages. */
export function useOptionalSubAccount(): SubAccountContextValue | null {
  return useContext(SubAccountContext) ?? null;
}
