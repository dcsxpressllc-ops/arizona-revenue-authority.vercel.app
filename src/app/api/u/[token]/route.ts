import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { verifyUnsubscribeToken } from "@/lib/automations/unsubscribe-token";

export const dynamic = "force-dynamic";

/**
 * Public unsubscribe: /u/[token] POSTs here to set `emailOptedOut`. POST so
 * link previewers in mail clients can't opt people out by fetching the URL.
 * Token is `{contactId}.{HMAC}` (lib/automations/unsubscribe-token.ts).
 */
export async function POST(
  _request: Request,
  ctx: { params: Promise<{ token: string }> },
) {
  const { token } = await ctx.params;

  const contactId = verifyUnsubscribeToken(token);
  if (!contactId) {
    return NextResponse.json(
      { error: "Invalid or expired link." },
      { status: 400 },
    );
  }

  const db = getAdminDb();
  const ref = db.doc(`contacts/${contactId}`);
  const snap = await ref.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Contact not found." }, { status: 404 });
  }

  await ref.update({
    emailOptedOut: true,
    updatedAt: FieldValue.serverTimestamp(),
  });

  // So the opt-out shows in the contact's timeline.
  try {
    await ref.collection("activities").add({
      type: "automation_step_skipped",
      content: "Email unsubscribe — clicked the link in an outbound email.",
      createdBy: "unsubscribe",
      meta: { kind: "email_opt_out" },
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.warn("[unsubscribe] activity write failed", err);
  }

  return NextResponse.json({ ok: true });
}
