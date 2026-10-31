import { MetaChannelSection } from "@/components/ai-agents/meta-channel-section";

// Messenger + Instagram DM settings. Persona is on the Overview page; the Meta
// connection is under Settings > Facebook & Instagram.
export default function AiAgentsMetaPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <MetaChannelSection />
    </div>
  );
}
