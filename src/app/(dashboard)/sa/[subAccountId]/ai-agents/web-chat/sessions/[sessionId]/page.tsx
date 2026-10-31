import { WebChatSessionThread } from "@/components/ai-agents/web-chat-session-thread";

// Web Chat session detail: live transcript, captured identity, linked contact.
export default async function WebChatSessionDetailPage({
  params,
}: {
  params: Promise<{ subAccountId: string; sessionId: string }>;
}) {
  const { sessionId } = await params;

  return (
    <div className="mx-auto max-w-3xl">
      <WebChatSessionThread sessionId={sessionId} />
    </div>
  );
}
