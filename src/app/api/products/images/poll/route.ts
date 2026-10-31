import { NextResponse } from "next/server";

import { qstashIsConfigured, verifyQStashSignature } from "@/lib/automations/qstash";
import { pollProductImage } from "@/lib/server/product-images-service";

export const dynamic = "force-dynamic";

/**
 * QStash tick for one AI product image job. Public path; the Upstash
 * signature is the credential. Expected outcomes are recorded on the product
 * and answered 200; an unexpected error answers 500 so QStash retries, which
 * is safe because a tick only acts on the product's current job.
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

  let body: { subAccountId?: unknown; productId?: unknown; jobId?: unknown; attempt?: unknown };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { subAccountId, productId, jobId, attempt } = body;
  if (
    typeof subAccountId !== "string" ||
    typeof productId !== "string" ||
    typeof jobId !== "string" ||
    typeof attempt !== "number"
  ) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  try {
    const result = await pollProductImage({ subAccountId, productId, jobId, attempt });
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    console.error(`[products/images/poll] failed product=${productId}`, err);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
