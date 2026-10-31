import { NextResponse } from "next/server";

import { qstashIsConfigured, verifyQStashSignature } from "@/lib/automations/qstash";
import { sendProductsChanged } from "@/lib/server/products-sync-service";

export const dynamic = "force-dynamic";
// gitpage commits to each affected site before answering.
export const maxDuration = 300;

/**
 * QStash tick that tells gitpage products changed. Public path; the Upstash
 * signature is the credential. Answers 500 when gitpage asks for a retry, so
 * QStash redelivers; a repeat is harmless (already-synced sites no-op).
 */
export async function POST(request: Request) {
  if (!qstashIsConfigured()) {
    return NextResponse.json({ error: "QStash is not configured." }, { status: 503 });
  }
  const signature = request.headers.get("upstash-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing Upstash-Signature header" }, { status: 401 });
  }
  const rawBody = await request.text();
  if (!(await verifyQStashSignature(signature, rawBody))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let body: { subAccountId?: unknown; productIds?: unknown; reason?: unknown };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { subAccountId, productIds, reason } = body;
  if (
    typeof subAccountId !== "string" ||
    !Array.isArray(productIds) ||
    !productIds.every((p) => typeof p === "string") ||
    (reason !== "updated" && reason !== "archived" && reason !== "unlisted")
  ) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const { retry } = await sendProductsChanged({ subAccountId, productIds: productIds as string[], reason });
  return NextResponse.json({ ok: !retry }, { status: retry ? 500 : 200 });
}
