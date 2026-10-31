import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";

/**
 * Funnel subdomain claims at `funnelSubdomains/{name}`. Slugs are unique per
 * sub-account, but subdomains are one global namespace, so claims get their
 * own collection keyed by name and change inside transactions. Server-only
 * (rules deny all):
 * the claim drives host routing, so a client-writable claim would let one
 * tenant hijack another's subdomain.
 */

/** App surfaces, mail and infra prefixes people expect to be "official". */
const RESERVED = new Set([
  "www", "app", "api", "mail", "email", "smtp", "imap", "pop", "ftp",
  "admin", "dashboard", "login", "signup", "auth", "account", "accounts",
  "help", "support", "docs", "blog", "status", "dev", "staging", "test",
  "cdn", "static", "assets", "img", "images", "pay", "billing", "checkout",
  "webhooks", "webhook", "ns1", "ns2", "mx", "autodiscover", "vercel",
]);

const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;

export function subdomainError(name: string): string | null {
  if (!name) return "Enter a subdomain.";
  if (name.length < 3) return "At least 3 characters.";
  if (!NAME_RE.test(name)) {
    return "Lowercase letters, numbers and hyphens only (no leading/trailing hyphen, max 40).";
  }
  if (RESERVED.has(name)) return `"${name}" is reserved.`;
  return null;
}

export function normaliseSubdomain(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]/g, "")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export interface SubdomainClaim {
  subAccountId: string;
  agencyId: string;
  funnelId: string;
}

/** null if unclaimed. The host-routing resolver's only read. */
export async function resolveSubdomain(
  name: string,
): Promise<SubdomainClaim | null> {
  if (subdomainError(name)) return null;
  const snap = await getAdminDb().doc(`funnelSubdomains/${name}`).get();
  return snap.exists ? (snap.data() as SubdomainClaim) : null;
}

export async function subdomainAvailable(
  name: string,
  forFunnelId?: string,
): Promise<boolean> {
  const claim = await resolveSubdomain(name);
  return !claim || claim.funnelId === forFunnelId;
}

export class SubdomainTakenError extends Error {
  constructor(name: string) {
    super(`"${name}" is already in use by another funnel.`);
    this.name = "SubdomainTakenError";
  }
}

/** Moves a funnel from `previous` to `next` (either nullable) in a transaction. Throws SubdomainTakenError if `next` belongs to another funnel. */
export async function reassignSubdomain(input: {
  previous: string | null;
  next: string | null;
  claim: SubdomainClaim;
}): Promise<void> {
  const { previous, next, claim } = input;
  if (previous === next) return;
  const db = getAdminDb();

  await db.runTransaction(async (tx) => {
    if (next) {
      const ref = db.doc(`funnelSubdomains/${next}`);
      const snap = await tx.get(ref);
      if (snap.exists && (snap.data() as SubdomainClaim).funnelId !== claim.funnelId) {
        throw new SubdomainTakenError(next);
      }
      tx.set(ref, { ...claim, claimedAt: FieldValue.serverTimestamp() });
    }
    if (previous) {
      const prevRef = db.doc(`funnelSubdomains/${previous}`);
      const prevSnap = await tx.get(prevRef);
      // Only release what this funnel owns; a stale doc mustn't delete someone else's claim.
      if (
        prevSnap.exists &&
        (prevSnap.data() as SubdomainClaim).funnelId === claim.funnelId
      ) {
        tx.delete(prevRef);
      }
    }
  });
}

/** `7dsummer` -> `7dsummer.leadstack.dev` from NEXT_PUBLIC_APP_URL. null when unset or localhost. */
export function subdomainHostname(name: string): string | null {
  const base = process.env.NEXT_PUBLIC_APP_URL;
  if (!base) return null;
  try {
    const host = new URL(base).hostname.replace(/^www\./, "");
    if (host === "localhost" || host.endsWith(".localhost")) return null;
    return `${name}.${host}`;
  } catch {
    return null;
  }
}
