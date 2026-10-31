import { notFound } from "next/navigation";
import { LANDING_VARIANT } from "@/config/landing";

/**
 * These are LeadStack's own product docs, so custom-branded deployments 404
 * every /docs route (same gate as /about).
 */
export default function DocsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (LANDING_VARIANT !== "leadstack") {
    notFound();
  }
  return children;
}
