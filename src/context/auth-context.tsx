"use client";

import {
  createContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { onAuthStateChanged, type User } from "firebase/auth";
import {
  collection,
  doc,
  getDoc,
  onSnapshot,
} from "firebase/firestore";
import {
  getFirebaseAuth,
  getFirebaseDb,
  isFirebaseConfigured,
} from "@/lib/firebase/client";
import { signOutUser } from "@/lib/firebase/auth";
import type {
  AgencyRole,
  AppConfig,
  MemberStatus,
  Role,
  UserDoc,
  UserSubAccountMembership,
} from "@/types";

export interface AuthContextValue {
  user: User | null;
  loading: boolean;
  /** Legacy single-tenant pointer (first signup's uid). New code should scope by subAccountId via useSubAccount(). */
  adminUid: string | null;
  /** Legacy role claim (admin | collaborator). Sub-account roles are per sub-account. */
  role: Role | null;
  status: MemberStatus | null;
  agencyId: string | null;
  /** Agency-level role (only owners are populated). */
  agencyRole: AgencyRole | null;
  /** Every sub-account this user belongs to (drives the switcher). Empty while loading. */
  memberships: UserSubAccountMembership[];
  /**
   * False until the first membership snapshot. `loading` goes false as soon as
   * the token and user doc resolve, before memberships arrive, so anything
   * deciding access from `memberships` must gate on this or it acts on an
   * empty list after refresh.
   */
  membershipsLoaded: boolean;
}

export const AuthContext = createContext<AuthContextValue | undefined>(
  undefined,
);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [adminUid, setAdminUid] = useState<string | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [status, setStatus] = useState<MemberStatus | null>(null);
  const [agencyId, setAgencyId] = useState<string | null>(null);
  const [agencyRole, setAgencyRole] = useState<AgencyRole | null>(null);
  const [memberships, setMemberships] = useState<UserSubAccountMembership[]>([]);
  const [membershipsLoaded, setMembershipsLoaded] = useState(false);

  useEffect(() => {
    if (!isFirebaseConfigured()) {
      setLoading(false);
      return;
    }

    let membershipUnsub: (() => void) | null = null;
    const cleanupMembership = () => {
      if (membershipUnsub) {
        membershipUnsub();
        membershipUnsub = null;
      }
    };

    const unsubscribe = onAuthStateChanged(
      getFirebaseAuth(),
      async (firebaseUser) => {
        setUser(firebaseUser);
        cleanupMembership();

        if (!firebaseUser) {
          setAdminUid(null);
          setRole(null);
          setStatus(null);
          setAgencyId(null);
          setAgencyRole(null);
          setMemberships([]);
          setMembershipsLoaded(true); // nothing to load
          setLoading(false);
          return;
        }

        // Re-gate until this user's memberships arrive (or error) below.
        setMembershipsLoaded(false);

        try {
          // Refresh the ID token first so new custom claims (status, agencyId,
          // agencyRole) are on it before any Firestore read. Otherwise rules see
          // a stale token without status "active" and deny the reads.
          const tokenResult = await firebaseUser
            .getIdTokenResult(true)
            .catch(() => null);
          const claims = tokenResult?.claims ?? {};

          const db = getFirebaseDb();
          const [cfgSnap, userSnap] = await Promise.all([
            getDoc(doc(db, "appConfig", "main")),
            getDoc(doc(db, "users", firebaseUser.uid)),
          ]);

          const cfg = cfgSnap.exists()
            ? (cfgSnap.data() as AppConfig)
            : null;
          const userDoc = userSnap.exists()
            ? (userSnap.data() as UserDoc)
            : null;

          if (!userDoc || userDoc.status !== "active") {
            // Removed/orphan user: sign out hard.
            await signOutUser().catch(() => undefined);
            setAdminUid(null);
            setRole(null);
            setStatus("removed");
            setAgencyId(null);
            setAgencyRole(null);
            setMemberships([]);
            setMembershipsLoaded(true);
            setUser(null);
            if (typeof window !== "undefined") {
              window.location.href = "/login?reason=removed";
            }
            return;
          }

          setAdminUid(cfg?.adminUid ?? null);
          setRole(userDoc.role);
          setStatus(userDoc.status);
          setAgencyId(
            (claims.agencyId as string | undefined) ??
              userDoc.primaryAgencyId ??
              null,
          );
          setAgencyRole(
            (claims.agencyRole as AgencyRole | null | undefined) ?? null,
          );

          // Claim pending invites for this email. The signup route 409s for
          // existing users, so this is the only path that attaches a second
          // or later membership. Idempotent; the subscription below picks up
          // whatever it writes.
          void fetch("/api/auth/claim-pending-invites", {
            method: "POST",
            credentials: "include",
          }).catch((err) => {
            console.warn("[auth] claim-pending-invites failed", err);
          });

          // Live so the switcher updates when an admin adds/removes them.
          membershipUnsub = onSnapshot(
            collection(db, `userMemberships/${firebaseUser.uid}/subAccounts`),
            (snap) => {
              const items: UserSubAccountMembership[] = snap.docs.map((d) => {
                const data = d.data() as Partial<UserSubAccountMembership>;
                return {
                  subAccountId: data.subAccountId ?? d.id,
                  agencyId: data.agencyId ?? "",
                  role: (data.role ?? "collaborator") as
                    | "admin"
                    | "collaborator",
                  name: data.name ?? "",
                  accountNumber: data.accountNumber,
                  addedAt:
                    data.addedAt instanceof Date
                      ? data.addedAt
                      : new Date(),
                };
              });
              // Stable order for every consumer: ascending account number,
              // unnumbered last, ties by name.
              items.sort((a, b) => {
                const an = a.accountNumber ?? Number.MAX_SAFE_INTEGER;
                const bn = b.accountNumber ?? Number.MAX_SAFE_INTEGER;
                if (an !== bn) return an - bn;
                return a.name.localeCompare(b.name, undefined, {
                  sensitivity: "base",
                });
              });
              setMemberships(items);
              setMembershipsLoaded(true);
            },
            () => {
              setMemberships([]);
              setMembershipsLoaded(true);
            },
          );
        } catch (err) {
          console.error("Failed to load auth context", err);
          // Don't strand membership-gated UI if setup threw before subscribing.
          setMembershipsLoaded(true);
        } finally {
          setLoading(false);
        }
      },
    );

    return () => {
      cleanupMembership();
      unsubscribe();
    };
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        adminUid,
        role,
        status,
        agencyId,
        agencyRole,
        memberships,
        membershipsLoaded,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
