import "server-only";

import {
  parseCaptureMarker as _parseCaptureMarker,
  parseFormMarker as _parseFormMarker,
  reconcileContactFromCapture as _reconcileContactFromCapture,
  type CaptureFieldId as _CaptureFieldId,
  type ParsedCapture as _ParsedCapture,
  type ParsedFormRequest as _ParsedFormRequest,
} from "@/lib/comms/ai/capture";
import { linkSessionToContact } from "@/lib/comms/web-chat/session";

/**
 * Web-chat wrappers over the generic `@/lib/comms/ai/capture` primitives that
 * also link the session row; the generic reconciler doesn't know about
 * webChatSessions. Voice uses the primitives directly.
 */

export type CaptureFieldId = _CaptureFieldId;
export type ParsedCapture = _ParsedCapture;
export type ParsedFormRequest = _ParsedFormRequest;

export const parseCaptureMarker = _parseCaptureMarker;
export const parseFormMarker = _parseFormMarker;

export interface ReconcileInput {
  agencyId: string;
  subAccountId: string;
  sessionId: string;
  /** Non-null = already linked, skip. */
  existingContactId: string | null;
  /**
   * Contact the session is linked to right now. When the result is a
   * different contact, the captured fields are replaced outright so the
   * session never shows the old contact's details next to the new one.
   */
  sessionContactId?: string | null;
  pageUrl: string | null;
  capture: NonNullable<ParsedCapture["capture"]>;
}

export interface ReconcileResult {
  contactId: string;
  /** false when an email match was reused or the session was already linked. */
  created: boolean;
}

export async function reconcileContactFromCapture(
  input: ReconcileInput,
): Promise<ReconcileResult | null> {
  const result = await _reconcileContactFromCapture({
    agencyId: input.agencyId,
    subAccountId: input.subAccountId,
    existingContactId: input.existingContactId,
    pageUrl: input.pageUrl,
    source: "web-chat",
    matchStrategy: "email-first",
    capture: input.capture,
  });
  if (!result) return null;

  await linkSessionToContact({
    subAccountId: input.subAccountId,
    sessionId: input.sessionId,
    contactId: result.contactId,
    capturedName: input.capture.name,
    capturedEmail: input.capture.email,
    capturedPhone: input.capture.phone,
    replaceCaptured:
      !!input.sessionContactId && input.sessionContactId !== result.contactId,
  });

  return result;
}
