import "server-only";

import { NextResponse } from "next/server";
import { requireAgencyOwner } from "@/lib/auth/require-agency-owner";
import { aiIsConfigured, defaultAiModel } from "@/lib/comms/ai/openrouter";

/**
 * Owner-only, read-only: the effective default OpenRouter model and whether it
 * comes from AI_REPLIES_DEFAULT_MODEL or the built-in default. No secrets.
 */
export async function GET(request: Request) {
  const auth = await requireAgencyOwner(request);
  if (auth instanceof NextResponse) return auth;

  return NextResponse.json({
    configured: aiIsConfigured(),
    model: defaultAiModel(),
    isOverride: !!process.env.AI_REPLIES_DEFAULT_MODEL?.trim(),
  });
}
