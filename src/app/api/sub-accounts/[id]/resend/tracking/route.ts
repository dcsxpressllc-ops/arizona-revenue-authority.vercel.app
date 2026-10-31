import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { setDomainTracking } from "@/lib/comms/resend-domains";
import type { ResendConfig, SubAccountDoc } from "@/types";

/**
 * Open + click tracking switch for a sub-account's sending domain.
 * POST: enable (needs the agency email-domain gate and a verified domain).
 * DELETE: disable. Both PATCH the Resend domain first, then store
 * `resendConfig.trackingEnabled` so the broadcast pages can explain zero
 * opens.
 */

async function flip(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
  enabled: boolean,
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  if (!process.env.RESEND_API_KEY) {
    return NextResponse.json(
      { error: "Resend isn't configured on this deployment (RESEND_API_KEY)." },
      { status: 503 },
    );
  }

  const db = getAdminDb();
  const subRef = db.doc(`subAccounts/${subAccountId}`);
  const sub = ((await subRef.get()).data() ?? {}) as Partial<SubAccountDoc>;

  if (sub.emailDomainEnabledByAgency !== true) {
    return NextResponse.json(
      {
        error:
          "The dedicated email sending domain feature is disabled for this sub-account. Ask your agency owner to enable it.",
      },
      { status: 403 },
    );
  }
  const cfg = sub.resendConfig as ResendConfig | null | undefined;
  // Enabling needs a verified domain; disabling only needs a domain to exist,
  // so a domain that later fails verification can't trap tracking on.
  if (!cfg?.domainId || (enabled && cfg.status !== "verified")) {
    return NextResponse.json(
      { error: "Verify your sending domain first — tracking is set on the domain." },
      { status: 400 },
    );
  }

  const result = await setDomainTracking(cfg.domainId, enabled);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error ?? "Failed to update tracking on Resend." },
      { status: 502 },
    );
  }

  // Dot-path write: spreading the config snapshot would race the verify and
  // inbox routes and could put a stale status back.
  await subRef.update({
    "resendConfig.trackingEnabled": enabled,
    updatedAt: FieldValue.serverTimestamp(),
  });
  return NextResponse.json({ ok: true, trackingEnabled: enabled });
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  return flip(request, ctx, true);
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  return flip(request, ctx, false);
}
