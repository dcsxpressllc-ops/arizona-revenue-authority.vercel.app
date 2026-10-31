import Link from "next/link";
import { ArrowLeft, PhoneCall } from "lucide-react";
import { VoiceCallsList } from "@/components/ai-agents/voice-calls-list";

// Voice call list, nested under the Voice channel so the AI Agents tabs stay visible.
export default async function VoiceCallsPage({
  params,
}: {
  params: Promise<{ subAccountId: string }>;
}) {
  const { subAccountId } = await params;

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <Link
        href={`/sa/${subAccountId}/ai-agents/voice`}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Voice settings
      </Link>

      <header className="flex items-start gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-500/10 text-violet-600 dark:text-violet-400">
          <PhoneCall className="h-5 w-5" />
        </span>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            Voice calls
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Every call the voice agent handled on this sub-account.
            Expand a row to peek at the summary; click through for the
            full transcript.
          </p>
        </div>
      </header>

      <VoiceCallsList />
    </div>
  );
}
