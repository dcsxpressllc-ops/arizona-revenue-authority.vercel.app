import "server-only";

import {
  createCaptureFollowUp,
  type CaptureFollowUpResult,
} from "@/lib/comms/ai/follow-up";

/** Web-chat wrapper over createCaptureFollowUp: web-chat labels and the sessions deep link. */

interface CreateFollowUpInput {
  agencyId: string;
  subAccountId: string;
  sessionId: string;
  contactId: string;
  capturedName: string | null;
  capturedEmail: string | null;
  capturedPhone: string | null;
  lastInboundMessage: string | null;
  pageUrl: string | null;
}

export type FollowUpResult = CaptureFollowUpResult;

export async function createFollowUpActions(
  input: CreateFollowUpInput,
): Promise<FollowUpResult> {
  return createCaptureFollowUp({
    agencyId: input.agencyId,
    subAccountId: input.subAccountId,
    channelId: "web-chat",
    channelLabel: "Web Chat",
    taskAction: "Follow up with",
    sessionNoun: "session",
    sessionId: input.sessionId,
    sessionDeepLinkPath: `/sa/${input.subAccountId}/ai-agents/web-chat/sessions/${input.sessionId}`,
    contactId: input.contactId,
    capturedName: input.capturedName,
    capturedEmail: input.capturedEmail,
    capturedPhone: input.capturedPhone,
    lastInboundMessage: input.lastInboundMessage,
    pageUrl: input.pageUrl,
  });
}
