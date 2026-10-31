import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import {
  deleteSubscription,
  getSubscription,
  subscriptionToResponse,
  updateSubscription,
} from "@/lib/firestore/webhook-subscriptions";
import {
  WEBHOOK_EVENT_TYPES,
  type WebhookEventType,
  type WebhookSubscriptionStatus,
} from "@/types/webhooks";
import { eventsAreSingleCategory } from "@/lib/webhooks/event-categories";
import { validateWebhookUrl } from "@/lib/webhooks/validate-url";

const EVENT_SET = new Set(WEBHOOK_EVENT_TYPES);
const VALID_STATUS: WebhookSubscriptionStatus[] = ["active", "paused"];

interface PatchBody {
  url?: string;
  description?: string | null;
  events?: string[];
  /** Manual pause/resume. "active" also clears a circuit-breaker pause. */
  status?: WebhookSubscriptionStatus;
}

/**
 * GET: one subscription (no signingSecret).
 * PATCH: url / events / description / status. Setting "active" on a
 * breaker-paused subscription also resets `consecutiveFailures`.
 * DELETE: remove it; in-flight deliveries end as subscription_deleted.
 */

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string; subId: string }> },
) {
  const { id: subAccountId, subId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const doc = await getSubscription(subAccountId, subId);
  if (!doc || doc.subAccountId !== subAccountId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ subscription: subscriptionToResponse(doc) });
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string; subId: string }> },
) {
  const { id: subAccountId, subId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const doc = await getSubscription(subAccountId, subId);
  if (!doc || doc.subAccountId !== subAccountId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const patch: Parameters<typeof updateSubscription>[2] = {};

  if (body.url !== undefined) {
    // Same SSRF rules as create (https in prod, no private/loopback hosts), so
    // an edit can't sneak around them.
    const urlCheck = validateWebhookUrl(
      typeof body.url === "string" ? body.url : "",
    );
    if (!urlCheck.ok) {
      return NextResponse.json({ error: urlCheck.error }, { status: 400 });
    }
    patch.url = urlCheck.url;
  }

  if (body.events !== undefined) {
    if (!Array.isArray(body.events)) {
      return NextResponse.json(
        { error: "events must be an array." },
        { status: 400 },
      );
    }
    for (const e of body.events) {
      if (!EVENT_SET.has(e as WebhookEventType)) {
        return NextResponse.json(
          { error: `Unknown event type '${e}'.` },
          { status: 400 },
        );
      }
    }
    if (!eventsAreSingleCategory(body.events as WebhookEventType[])) {
      return NextResponse.json(
        {
          error:
            "A webhook can only subscribe to events from one category. Create a separate webhook per category.",
        },
        { status: 400 },
      );
    }
    patch.events = body.events as WebhookEventType[];
  }

  if (body.description !== undefined) {
    patch.description =
      typeof body.description === "string" && body.description.trim()
        ? body.description.trim().slice(0, 120)
        : null;
  }

  if (body.status !== undefined) {
    if (!VALID_STATUS.includes(body.status)) {
      return NextResponse.json(
        { error: `Status must be one of: ${VALID_STATUS.join(", ")}.` },
        { status: 400 },
      );
    }
    patch.status = body.status;
    // Lets the UI tell "you paused this" from "the circuit breaker paused this".
    if (body.status === "paused") patch.pausedReason = "manual";
  }

  await updateSubscription(subAccountId, subId, patch);
  const updated = await getSubscription(subAccountId, subId);
  return NextResponse.json({
    subscription: updated ? subscriptionToResponse(updated) : null,
  });
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string; subId: string }> },
) {
  const { id: subAccountId, subId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const doc = await getSubscription(subAccountId, subId);
  if (!doc || doc.subAccountId !== subAccountId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  await deleteSubscription(subAccountId, subId);
  return NextResponse.json({ ok: true });
}
