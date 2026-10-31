import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { generateSigningSecret } from "@/lib/api/webhooks/signing";
import {
  createSubscription,
  listSubscriptions,
  subscriptionToResponse,
} from "@/lib/firestore/webhook-subscriptions";
import {
  WEBHOOK_EVENT_TYPES,
  type WebhookEventType,
} from "@/types/webhooks";
import { eventsAreSingleCategory } from "@/lib/webhooks/event-categories";
import { validateWebhookUrl } from "@/lib/webhooks/validate-url";

/**
 * Webhook subscriptions, same shape as the api-keys routes.
 * GET: list (`?mode=live|test`).
 * POST { url, events, description?, mode }: create. The response is the only
 * time `signingSecret` is returned.
 * Admin only (agency owner counts).
 */

const MODES = new Set(["live", "test"]);
const EVENT_SET = new Set(WEBHOOK_EVENT_TYPES);

interface CreateBody {
  url?: string;
  events?: string[];
  description?: string | null;
  mode?: "live" | "test";
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const url = new URL(request.url);
  const modeParam = url.searchParams.get("mode");
  const mode = modeParam && MODES.has(modeParam) ? (modeParam as "live" | "test") : undefined;

  const docs = await listSubscriptions(subAccountId, { mode });
  return NextResponse.json({
    subscriptions: docs.map(subscriptionToResponse),
  });
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: CreateBody;
  try {
    body = (await request.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.mode || !MODES.has(body.mode)) {
    return NextResponse.json(
      { error: "Mode must be 'live' or 'test'." },
      { status: 400 },
    );
  }

  const urlCheck = validateWebhookUrl(body.url ?? "");
  if (!urlCheck.ok) {
    return NextResponse.json({ error: urlCheck.error }, { status: 400 });
  }

  const events = Array.isArray(body.events) ? body.events : [];
  for (const e of events) {
    if (!EVENT_SET.has(e as WebhookEventType)) {
      return NextResponse.json(
        { error: `Unknown event type '${e}'.` },
        { status: 400 },
      );
    }
  }
  // One category per subscription. Empty is the old "all events" wildcard and
  // is still allowed.
  if (!eventsAreSingleCategory(events as WebhookEventType[])) {
    return NextResponse.json(
      {
        error:
          "A webhook can only subscribe to events from one category. Create a separate webhook per category.",
      },
      { status: 400 },
    );
  }

  const description =
    typeof body.description === "string" && body.description.trim()
      ? body.description.trim().slice(0, 120)
      : null;

  const subSnap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  if (!subSnap.exists) {
    return NextResponse.json(
      { error: "Sub-account not found" },
      { status: 404 },
    );
  }
  const subData = subSnap.data()!;
  const agencyId = (subData.agencyId as string) ?? "";
  if (!agencyId) {
    return NextResponse.json(
      { error: "Sub-account missing agencyId" },
      { status: 500 },
    );
  }

  // Webhooks share the public-API kill switch with API keys.
  if (subData.apiAccessEnabledByAgency !== true) {
    return NextResponse.json(
      {
        error:
          "API access is disabled for this sub-account. Your agency administrator can enable it from Manage in the agency sub-accounts list.",
      },
      { status: 403 },
    );
  }

  const signingSecret = generateSigningSecret();
  const doc = await createSubscription({
    subAccountId,
    agencyId,
    mode: body.mode,
    url: urlCheck.url,
    description,
    events: events as WebhookEventType[],
    signingSecret,
    createdByUid: access.uid,
  });

  return NextResponse.json({
    subscription: {
      ...subscriptionToResponse(doc),
      signingSecret,
    },
  });
}
