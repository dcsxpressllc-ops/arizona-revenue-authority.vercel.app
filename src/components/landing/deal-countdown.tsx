// Hello world
import type { CountdownParts } from "@/hooks/use-deal-urgency";

export function DealCountdown(_props: {
  parts: CountdownParts;
  size?: "sm" | "md";
  className?: string;
}) {
  return null;
}

export function formatCountdownShort(_parts: CountdownParts): string {
  return "";
}
