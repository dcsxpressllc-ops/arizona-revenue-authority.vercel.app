import { ChannelNav } from "@/components/ai-agents/channel-nav";

// Channel tabs render once here so switching channels only re-renders the body.
export default function AiAgentsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="sticky top-0 z-20 -mx-4 -mt-4 bg-background/95 backdrop-blur md:-mx-6 md:-mt-6">
        <ChannelNav />
      </div>
      <div className="flex-1 pt-10">{children}</div>
    </div>
  );
}
