import { NextResponse } from "next/server";
import { Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { isValidSessionId } from "@/lib/comms/web-chat/session";
import { liveOffer } from "@/lib/comms/ai/booking-turn";
import type { WebChatBookingOffer } from "@/types/web-chat";

export const dynamic = "force-dynamic";

/**
 * Widget delivery poll, every few seconds while chat is open. Picks up
 * outbound messages the iframe doesn't have yet: operator takeover replies
 * and approved suggest-mode drafts from the inbox.
 *
 * Anonymous like /message and /capture (Origin is useless from our own
 * iframe). The unguessable session id is the credential and only exposes
 * that session's own transcript. Read-only, bounded query.
 */

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

/** Buttons shown under a voice call. The prompt still sees the full list. */
const MAX_SLOT_BUTTONS = 6;

/**
 * The live offer (a new booking or moving one) as buttons, spread two per
 * day first so a busy first day doesn't hide later ones. Null when nothing
 * is on offer or the offer expired.
 */
function offerButtons(
  stored: WebChatBookingOffer | undefined,
): { key: number; slots: { startIso: string; label: string }[] } | null {
  const offer = liveOffer(stored);
  if (!offer) return null;
  // Labels look like "Tue, Oct 27, 10:00 AM"; everything before the last comma is the day.
  const dayOf = (label: string) => label.slice(0, label.lastIndexOf(","));
  const perDay = new Map<string, number>();
  const chosen = new Set<string>();
  for (const s of offer.slots) {
    if (chosen.size >= MAX_SLOT_BUTTONS) break;
    const n = perDay.get(dayOf(s.label)) ?? 0;
    if (n < 2) {
      chosen.add(s.startIso);
      perDay.set(dayOf(s.label), n + 1);
    }
  }
  for (const s of offer.slots) {
    if (chosen.size >= MAX_SLOT_BUTTONS) break;
    chosen.add(s.startIso);
  }
  return {
    key: offer.offeredAtMs,
    slots: offer.slots
      .filter((s) => chosen.has(s.startIso))
      .map((s) => ({ startIso: s.startIso, label: s.label })),
  };
}

export async function OPTIONS(request: Request) {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(request.headers.get("origin")),
  });
}

export async function GET(request: Request) {
  const headers = corsHeaders(request.headers.get("origin"));
  const url = new URL(request.url);
  const subAccountId = url.searchParams.get("sa")?.trim();
  const sessionId = url.searchParams.get("sessionId")?.trim();
  const afterMs = Number(url.searchParams.get("after") ?? "0") || 0;
  // During a voice call the widget never sees the reply payload, so it asks
  // here for the times currently on offer and shows them as buttons.
  const withOffer = url.searchParams.get("withOffer") === "1";

  if (!subAccountId || !isValidSessionId(sessionId)) {
    return NextResponse.json(
      { messages: [], serverNowMs: Date.now() },
      { status: 200, headers },
    );
  }

  try {
    const sessionRef = getAdminDb().doc(
      `subAccounts/${subAccountId}/webChatSessions/${sessionId}`,
    );
    // Single-field range on createdAt, served by the automatic index; direction
    // is filtered in memory to avoid a composite index.
    const [snap, sessionSnap] = await Promise.all([
      sessionRef
        .collection("messages")
        .where("createdAt", ">", Timestamp.fromMillis(afterMs))
        .orderBy("createdAt", "asc")
        .limit(50)
        .get(),
      withOffer ? sessionRef.get() : Promise.resolve(null),
    ]);
    const offer = withOffer
      ? offerButtons(sessionSnap?.data()?.bookingOffer as WebChatBookingOffer | undefined)
      : undefined;

    const messages = snap.docs
      .map((d) => {
        const data = d.data() as {
          direction?: string;
          via?: string;
          body?: string;
          createdAt?: { toMillis?: () => number };
        };
        return {
          id: d.id,
          direction: data.direction ?? "outbound",
          body: data.body ?? "",
          via: data.via === "voice" ? ("voice" as const) : undefined,
          createdAtMs:
            typeof data.createdAt?.toMillis === "function"
              ? data.createdAt.toMillis()
              : 0,
        };
      })
      // Visitors already see their own turns.
      .filter((m) => m.direction === "outbound" && m.body);

    return NextResponse.json(
      {
        messages: messages.map((m) => ({
          id: m.id,
          body: m.body,
          // Voice turns are rendered live by the voice SDK; flagged so they aren't
          // duplicated.
          ...(m.via ? { via: m.via } : {}),
          createdAtMs: m.createdAtMs,
        })),
        ...(offer !== undefined ? { offer } : {}),
        serverNowMs: Date.now(),
      },
      { status: 200, headers },
    );
  } catch (err) {
    console.warn(
      `[web-chat/poll] sa=${subAccountId} session=${sessionId} failed`,
      err,
    );
    return NextResponse.json(
      { messages: [], serverNowMs: Date.now() },
      { status: 200, headers },
    );
  }
}
