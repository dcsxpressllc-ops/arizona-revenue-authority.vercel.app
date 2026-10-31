import { EmailChannelSection } from "@/components/ai-agents/email-channel-section";

// Email AI channel: draft-only replies to inbound inbox mail. Persona is on the
// Overview page; the inbox is set up under Settings > Email sending domain.
export default function AiAgentsEmailPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <EmailChannelSection />
    </div>
  );
}
