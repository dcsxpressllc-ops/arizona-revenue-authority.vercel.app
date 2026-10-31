import { SmsChannelSection } from "@/components/ai-agents/sms-channel-section";

// SMS channel settings. The shared persona is on the Overview page.
export default function AiAgentsSmsPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <SmsChannelSection />
    </div>
  );
}
