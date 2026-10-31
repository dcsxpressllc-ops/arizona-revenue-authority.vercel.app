import { WhatsappChannelSection } from "@/components/ai-agents/whatsapp-channel-section";

// WhatsApp channel settings. Persona is on the Overview page; the sender
// number is configured under Settings > SMS.
export default function AiAgentsWhatsappPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <WhatsappChannelSection />
    </div>
  );
}
