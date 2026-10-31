import { WebChatChannelSection } from "@/components/ai-agents/web-chat-channel-section";
import { WebVoiceSection } from "@/components/ai-agents/web-voice-section";

// Web Chat settings + embed snippet, then the optional ElevenLabs Web Voice
// card. Persona and KB are on the Overview page.
export default function AiAgentsWebChatPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <WebChatChannelSection />
      <WebVoiceSection />
    </div>
  );
}
