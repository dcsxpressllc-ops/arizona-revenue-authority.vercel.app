import { NextResponse } from "next/server";
import { requireContactAccessible, requireUid } from "@/lib/comms/route-auth";
import { maybeSendReviewRequest } from "@/lib/reviews/request";

type Body = { contactId?: string };

/**
 * Manual "Request review" from the contact profile. trigger "manual" bypasses
 * the cooldown but still stamps it; the outcome is returned so the UI can
 * toast the exact reason.
 */
export async function POST(request: Request) {
  const auth = requireUid(request);
  if (auth instanceof NextResponse) return auth;

  let payload: Body;
  try {
    payload = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const contactId = payload.contactId?.trim();
  if (!contactId) {
    return NextResponse.json({ error: "contactId is required" }, { status: 400 });
  }

  const contact = await requireContactAccessible(auth.uid, contactId);
  if (contact instanceof NextResponse) return contact;

  const result = await maybeSendReviewRequest({
    subAccountId: contact.subAccountId,
    agencyId: contact.agencyId,
    contactId,
    trigger: "manual",
  });

  return NextResponse.json({ ok: true, sent: result.sent, reason: result.reason });
}
