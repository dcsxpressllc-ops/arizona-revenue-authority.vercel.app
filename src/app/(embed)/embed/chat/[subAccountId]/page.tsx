import { notFound } from "next/navigation";
import { getChannelConfig } from "@/lib/comms/ai/agent";
import { ChatWindow } from "@/components/web-chat/chat-window";
import { DEFAULT_WEB_CHAT_CONFIG } from "@/types/ai";

export const dynamic = "force-dynamic";

/**
 * Iframe target for the chat widget snippet. No auth. 404s when web chat is
 * disabled or never configured. Origin allowlisting happens in
 * /api/web-chat/message, not here; the page can't send messages on its own.
 */
export default async function EmbedChatPage({
  params,
}: {
  params: Promise<{ subAccountId: string }>;
}) {
  const { subAccountId } = await params;
  const config = await getChannelConfig(subAccountId, "web-chat");
  if (!config || !config.enabled || !config.webChat) {
    notFound();
  }

  const welcomeMessage =
    config.webChat.welcomeMessage || DEFAULT_WEB_CHAT_CONFIG.welcomeMessage;
  const accentColor =
    config.webChat.accentColor || DEFAULT_WEB_CHAT_CONFIG.accentColor;

  return (
    <ChatWindow
      subAccountId={subAccountId}
      welcomeMessage={welcomeMessage}
      accentColor={accentColor}
      embedded
    />
  );
}
