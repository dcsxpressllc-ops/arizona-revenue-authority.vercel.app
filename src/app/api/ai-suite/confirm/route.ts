import "server-only";

import { NextResponse } from "next/server";
import { requireAgencyOwnerAny, requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { getAdminAuth, getAdminDb } from "@/lib/firebase/admin";
import {
  CapabilityUserError,
  getCapability,
  roleSatisfies,
  type AiSuiteActionContext,
} from "@/lib/ai-suite/capabilities";
import { recordAiSuiteAction } from "@/lib/ai-suite/audit";
import { recordAiSuiteUsage } from "@/lib/ai-suite/usage";
import type { AiSuiteConfirmRequest } from "@/types/ai-suite";

import { runAfterResponse } from "@/lib/server/after-response";
export const dynamic = "force-dynamic";

/**
 * Executes a confirmed AI Suite proposal. The only place a write happens:
 * re-authenticates, re-checks the capability role, re-validates the args.
 * Tenant scope comes from the session, never from the request body.
 */
export async function POST(request: Request) {
  let body: AiSuiteConfirmRequest;
  try {
    body = (await request.json()) as AiSuiteConfirmRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const level = body.level;
  if (level !== "agency" && level !== "sub-account") {
    return NextResponse.json(
      { error: "`level` must be 'agency' or 'sub-account'." },
      { status: 400 },
    );
  }

  // Readonly lookups run inline in the chat route and aren't confirmable.
  const cap = getCapability(body.capability);
  if (!cap || cap.level !== level || cap.readonly) {
    return NextResponse.json(
      { error: "Unknown or unavailable action." },
      { status: 400 },
    );
  }

  // Auth, role and gate. The handler context comes from here, not the body.
  let ctx: AiSuiteActionContext;
  if (level === "sub-account") {
    if (!body.subAccountId || typeof body.subAccountId !== "string") {
      return NextResponse.json(
        { error: "`subAccountId` is required for sub-account level." },
        { status: 400 },
      );
    }
    const access = await requireSubAccountMember(request, body.subAccountId);
    if (access instanceof NextResponse) return access;

    const subSnap = await getAdminDb()
      .doc(`subAccounts/${body.subAccountId}`)
      .get();
    // Opt-in: off unless the agency owner enabled it (unset reads as off).
    if (subSnap.data()?.aiSuiteEnabledByAgency !== true) {
      return NextResponse.json(
        {
          error:
            "The AI Suite is disabled for this sub-account. Ask your agency owner to enable it.",
        },
        { status: 403 },
      );
    }

    if (
      !roleSatisfies(cap.requiredRole, {
        agencyRoleIsOwner: access.subAccountRole === "agencyOwner",
        subAccountRole: access.subAccountRole,
      })
    ) {
      return NextResponse.json(
        { error: "You don't have permission to perform this action." },
        { status: 403 },
      );
    }

    ctx = {
      uid: access.uid,
      email: access.email,
      displayName: "",
      agencyId: access.agencyId ?? "",
      subAccountId: body.subAccountId,
      subAccountRole: access.subAccountRole,
    };
  } else {
    const owner = await requireAgencyOwnerAny(request);
    if (owner instanceof NextResponse) return owner;
    // Same switch as the chat route, so a stale proposal can't run after it's off.
    const agencySnap = await getAdminDb()
      .doc(`agencies/${owner.agencyId}`)
      .get();
    if (agencySnap.data()?.agencyAssistantEnabled !== true) {
      return NextResponse.json(
        {
          error:
            "The Agency Assistant is turned off. Enable it under Agency → Settings.",
        },
        { status: 403 },
      );
    }
    if (!roleSatisfies(cap.requiredRole, { agencyRoleIsOwner: true })) {
      return NextResponse.json(
        { error: "You don't have permission to perform this action." },
        { status: 403 },
      );
    }
    // Cosmetic, but keeps member lists matching UI-created sub-accounts.
    let displayName = "";
    try {
      const record = await getAdminAuth().getUser(owner.uid);
      displayName = record.displayName ?? "";
    } catch {
      /* non-fatal */
    }
    ctx = {
      uid: owner.uid,
      email: owner.email,
      displayName,
      agencyId: owner.agencyId ?? "",
    };
  }

  // Card-collected secrets are merged in here and nowhere else: only the keys
  // the capability declares, and never into the audit row or the thread.
  const secretKeys = (cap.secretInputs ?? []).map((s) => s.key);
  const rawArgs: Record<string, unknown> = {
    ...(body.args && typeof body.args === "object" ? body.args : {}),
  };
  for (const key of secretKeys) {
    delete rawArgs[key];
    const v = body.secrets?.[key];
    if (typeof v === "string" && v.trim()) rawArgs[key] = v.trim();
  }

  // Re-validate; the client payload is never trusted.
  // `retry` tells the card to stay open so a mistyped secret can be fixed in
  // place; only meaningful for capabilities that collect one.
  const retry = secretKeys.length > 0;
  const validated = cap.validate(rawArgs);
  if (!validated.ok) {
    return NextResponse.json(
      { error: `Can't run that action: ${validated.error}.`, ...(retry ? { retry } : {}) },
      { status: 400 },
    );
  }

  const summary = cap.summarize(validated.args);
  const auditArgs = { ...validated.args };
  for (const key of secretKeys) delete auditArgs[key];

  try {
    const result = await cap.execute(ctx, validated.args);
    await recordAiSuiteAction({
      level,
      capability: cap.name,
      args: auditArgs,
      summary,
      status: "executed",
      agencyId: ctx.agencyId,
      subAccountId: ctx.subAccountId ?? null,
      confirmedByUid: ctx.uid,
      confirmedByEmail: ctx.email,
      resultRef: result.ref ?? null,
    });
    runAfterResponse(() => recordAiSuiteUsage({
      level,
      agencyId: ctx.agencyId,
      subAccountId: ctx.subAccountId,
      kind: "action",
    }));
    return NextResponse.json({ ok: true, resultText: result.resultText });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error(`[ai-suite/confirm] ${cap.name} failed:`, msg);
    await recordAiSuiteAction({
      level,
      capability: cap.name,
      args: auditArgs,
      summary,
      status: "failed",
      agencyId: ctx.agencyId,
      subAccountId: ctx.subAccountId ?? null,
      confirmedByUid: ctx.uid,
      confirmedByEmail: ctx.email,
      error: msg.slice(0, 500),
    });
    // User-facing failures surface verbatim; anything unexpected stays generic.
    if (err instanceof CapabilityUserError) {
      return NextResponse.json(
        { error: err.message, ...(retry ? { retry } : {}) },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { error: "The action failed to run. Please try again." },
      { status: 500 },
    );
  }
}
