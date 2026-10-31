import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import {
  requireAgencyOwnerAny,
  requireSubAccountMember,
} from "@/lib/auth/require-tenancy";
import { getAdminDb } from "@/lib/firebase/admin";
import type { AiSuiteLevel } from "@/types/ai-suite";

export const dynamic = "force-dynamic";

/**
 * Persisted AI Suite chat threads, one per user per level (and sub-account),
 * so a refresh keeps the conversation. History only, never authority: a
 * restored proposal still goes through the confirm route's re-auth.
 * Admin SDK only, at `subAccounts/{id}/aiSuiteThreads/{uid}` or
 * `agencies/{agencyId}/aiSuiteThreads/{uid}`.
 */

const MAX_MESSAGES = 60;
const MAX_CONTENT_CHARS = 6000;

const PROPOSAL_STATUSES = new Set([
  "pending",
  "confirmed",
  "cancelled",
  "failed",
]);

type StoredMessage = Record<string, unknown>;

/** Validate + normalize one client-supplied thread message; null = drop it. */
function sanitizeStoredMessage(raw: unknown): StoredMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  if (m.kind === "text") {
    if (m.role !== "user" && m.role !== "assistant") return null;
    if (typeof m.content !== "string" || !m.content.trim()) return null;
    return {
      role: m.role,
      kind: "text",
      content: m.content.slice(0, MAX_CONTENT_CHARS),
    };
  }
  if (m.kind === "navigate") {
    if (
      typeof m.content !== "string" ||
      typeof m.href !== "string" ||
      typeof m.label !== "string" ||
      // Same-origin paths only (no "//host" or absolute URLs), so a stored
      // thread can't smuggle an external link into the chat.
      !/^\/(?!\/)/.test(m.href)
    ) {
      return null;
    }
    return {
      role: "assistant",
      kind: "navigate",
      content: m.content.slice(0, MAX_CONTENT_CHARS),
      href: m.href.slice(0, 300),
      label: m.label.slice(0, 120),
    };
  }
  if (m.kind === "proposal") {
    if (
      typeof m.id !== "string" ||
      typeof m.capability !== "string" ||
      typeof m.summary !== "string" ||
      !m.args ||
      typeof m.args !== "object" ||
      Array.isArray(m.args) ||
      typeof m.status !== "string" ||
      !PROPOSAL_STATUSES.has(m.status)
    ) {
      return null;
    }
    return {
      role: "assistant",
      kind: "proposal",
      id: m.id.slice(0, 128),
      capability: m.capability.slice(0, 64),
      args: m.args,
      summary: m.summary.slice(0, MAX_CONTENT_CHARS),
      status: m.status,
      resultText:
        typeof m.resultText === "string"
          ? m.resultText.slice(0, MAX_CONTENT_CHARS)
          : null,
    };
  }
  return null;
}

/** Auth and resolve the thread path, gated exactly like the chat route. */
async function resolveThreadDoc(
  request: Request,
  level: string | null,
  subAccountId: string | null,
): Promise<{ path: string } | NextResponse> {
  if (level !== "agency" && level !== "sub-account") {
    return NextResponse.json(
      { error: "`level` must be 'agency' or 'sub-account'." },
      { status: 400 },
    );
  }
  if (level === "sub-account") {
    if (!subAccountId) {
      return NextResponse.json(
        { error: "`subAccountId` is required for sub-account level." },
        { status: 400 },
      );
    }
    const access = await requireSubAccountMember(request, subAccountId);
    if (access instanceof NextResponse) return access;
    const subSnap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
    // Opt-in gate; unset reads as disabled, same as the chat route.
    if (subSnap.data()?.aiSuiteEnabledByAgency !== true) {
      return NextResponse.json(
        { error: "The AI Suite is disabled for this sub-account." },
        { status: 403 },
      );
    }
    return { path: `subAccounts/${subAccountId}/aiSuiteThreads/${access.uid}` };
  }
  const owner = await requireAgencyOwnerAny(request);
  if (owner instanceof NextResponse) return owner;
  return { path: `agencies/${owner.agencyId}/aiSuiteThreads/${owner.uid}` };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const resolved = await resolveThreadDoc(
    request,
    url.searchParams.get("level"),
    url.searchParams.get("subAccountId"),
  );
  if (resolved instanceof NextResponse) return resolved;

  const snap = await getAdminDb().doc(resolved.path).get();
  const messages = snap.exists ? (snap.data()?.messages ?? []) : [];
  return NextResponse.json({ messages });
}

export async function PUT(request: Request) {
  let body: {
    level?: AiSuiteLevel;
    subAccountId?: string;
    messages?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const resolved = await resolveThreadDoc(
    request,
    body.level ?? null,
    body.subAccountId ?? null,
  );
  if (resolved instanceof NextResponse) return resolved;

  if (!Array.isArray(body.messages)) {
    return NextResponse.json(
      { error: "`messages` must be an array." },
      { status: 400 },
    );
  }
  const messages = body.messages
    .map(sanitizeStoredMessage)
    .filter((m): m is StoredMessage => m !== null)
    .slice(-MAX_MESSAGES);

  await getAdminDb().doc(resolved.path).set({
    level: body.level,
    messages,
    updatedAt: FieldValue.serverTimestamp(),
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const resolved = await resolveThreadDoc(
    request,
    url.searchParams.get("level"),
    url.searchParams.get("subAccountId"),
  );
  if (resolved instanceof NextResponse) return resolved;

  await getAdminDb().doc(resolved.path).delete();
  return NextResponse.json({ ok: true });
}
