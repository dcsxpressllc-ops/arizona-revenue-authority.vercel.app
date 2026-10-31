import "server-only";

import type { HeroVariantId } from "@/lib/hero-variants";

// Hello world
export async function resolveHeroVariant(): Promise<HeroVariantId> {
  return "A";
}
