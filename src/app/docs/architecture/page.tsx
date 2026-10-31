import type { Metadata } from "next";
import { ArchitectureDiagram } from "@/components/docs/architecture-diagram";

export const metadata: Metadata = {
  title: "Architecture",
  description:
    "How LeadStack hangs together — eight product domains in one tube-map view.",
};

/**
 * Public architecture diagram at /docs/architecture. No auth needed since
 * /docs is in PUBLIC_PATHS. Kept light so the URL works as a shareable one-pager.
 */
export default function ArchitecturePage() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <header className="mb-6">
        <p className="text-xs uppercase tracking-wider text-muted-foreground">
          Architecture · one-page view
        </p>
        <h1 className="mt-1 text-3xl font-bold tracking-tight">
          LeadStack — what&apos;s in the box
        </h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Eight product domains drawn as tube lines. Every line passes
          through <strong>Contact</strong> and is gated by{" "}
          <strong>Sub-Account</strong> — the central interchanges. Dashed
          bridges show how leads flow between domains: capture or AI
          conversations land as a Contact; the operator (or automation)
          reaches out via Comms; deals progress through the Sales line.
        </p>
      </header>
      <ArchitectureDiagram />
    </div>
  );
}
