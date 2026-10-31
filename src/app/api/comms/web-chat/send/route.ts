import { NextResponse } from "next/server";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { getAdminDb } from "@/lib/firebase/admin";
import { appendMessage, isValidSessionId } from "@/lib/comms/web-chat/session";
import {
  upsertConversationForMessage,
} from "@/lib/server/conversations-service";
import { webChatConversationId } from "@/types/conversations";
import { webChatVisitorLabel } from "@/lib/comms/web-chat/respond";

export const dynamic = "force-dynamic";

/**
 * Operator takeover reply for Web Chat. No provider here: the visitor's widget
 * picks the row up via /api/web-chat/poll. Same contract as the SMS/WhatsApp send routes.
 */

const MAX_CHARS = 4000;

export async function POST(request: Request) {
  let body: {
    subAccountId?: string;
    sessionId?: string;
    body?: string;
    approvedDraft?: boolean;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const subAccountId = body.subAccountId?.trim();
  const sessionId = body.sessionId?.trim();
  const text = body.body?.trim();

  if (!subAccountId) {
    return NextResponse.json({ error: "Missing subAccountId" }, { status: 400 });
  }
  if (!isValidSessionId(sessionId)) {
    return NextResponse.json({ error: "Invalid sessionId" }, { status: 400 });
  }
  if (!text || text.length > MAX_CHARS) {
    return NextResponse.json(
      { error: `Message must be 1-${MAX_CHARS} characters` },
      { status: 400 },
    );
  }

  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const db = getAdminDb();
  const sessionRef = db.doc(
    `subAccounts/${subAccountId}/webChatSessions/${sessionId}`,
  );
  const sessionSnap = await sessionRef.get();
  if (!sessionSnap.exists) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  const session = sessionSnap.data() as {
    agencyId: string;
    contactId: string | null;
    capturedName: string | null;
    capturedPhone: string | null;
    pageUrl: string | null;
    referrer: string | null;
  };

  let messageId: string;
  try {
    messageId = await appendMessage({
      subAccountId,
      agencyId: session.agencyId,
      sessionId,
      direction: "outbound",
      body: text,
      tokens: null,
      aiGenerated: false,
    });
  } catch (err) {
    console.error(`[comms/web-chat/send] append failed sa=${subAccountId}`, err);
    return NextResponse.json({ error: "Couldn't send." }, { status: 500 });
  }

  // pauseBot stands the AI down, marks the thread read and clears any suggest draft.
  const label = webChatVisitorLabel(session.pageUrl ?? null, session.referrer ?? null);
  await upsertConversationForMessage({
    contactId: session.contactId,
    conversationKey: webChatConversationId(sessionId),
    sessionId,
    visitorLabel: label,
    subAccountId,
    agencyId: session.agencyId,
    contactName: session.capturedName?.trim()
      ? session.capturedName.trim()
      : session.contactId
        ? "Web lead"
        : label,
    contactPhone: session.capturedPhone ?? null,
    channel: "web-chat",
    direction: "outbound",
    body: text,
    pauseBot: true,
    // The inbox draft card sets this; it bills the AI reply once actually sent.
    approvedDraft: body.approvedDraft === true,
  });

  return NextResponse.json({ ok: true, messageId }, { status: 200 });
}
