import { WhatsappTemplatesManager } from "@/components/ai-agents/whatsapp-templates-manager";

// Create, submit and track approval of Meta WhatsApp message templates.
export default function AiAgentsWhatsappTemplatesPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <WhatsappTemplatesManager />
    </div>
  );
}
