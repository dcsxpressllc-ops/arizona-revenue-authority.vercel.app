import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Vapi status webhook (status-update, speech-update, hang, ...). Only the
 * headline state (started, ended, failed) is written to
 * `voiceCalls/{callId}`; everything else is acknowledged and ignored.
 * End-of-call analysis has its own endpoint so neither blocks the other.
 */

interface VapiStatusMessage {
  message?: {
    type?: string;
    status?: string;
    call?: { id?: string };
  };
}

function authorize(request: Request): boolean {
  const expected = process.env.VAPI_WEBHOOK_SECRET?.trim();
  if (!expected) return false;
  // Secret is in the URL; see authorize() in the LLM route.
  const provided = new URL(request.url).searchParams.get("s")?.trim() ?? "";
  return provided.length > 0 && provided === expected;
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ subAccountId: string }> },
) {
  if (!authorize(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { subAccountId } = await ctx.params;

  let body: VapiStatusMessage;
  try {
    body = (await request.json()) as VapiStatusMessage;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const message = body.message ?? {};
  if (message.type !== "status-update") {
    return NextResponse.json({ ok: true, ignored: message.type ?? "unknown" });
  }

  const callId = message.call?.id;
  const status = message.status;
  if (!callId || !status) {
    return NextResponse.json({ ok: true, ignored: "missing call.id or status" });
  }

  try {
    await getAdminDb()
      .doc(`subAccounts/${subAccountId}/voiceCalls/${callId}`)
      .set(
        {
          subAccountId,
          callId,
          liveStatus: status,
          liveStatusAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
  } catch (err) {
    console.warn(
      `[vapi/status] write failed sa=${subAccountId} call=${callId}`,
      err,
    );
  }

  return NextResponse.json({ ok: true });
}
