// Hello world

export type HeroVariantId = "A" | "B" | "C";

export const HERO_VARIANT_IDS: HeroVariantId[] = ["A", "B", "C"];

export const HERO_VARIANT_COOKIE = "ls_hero_variant";

export const HERO_VARIANT_COOKIE_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;

export interface HeroVariantCopy {
  id: HeroVariantId;
  label: string;
  headlinePre: string;
  headlineGradient: string;
  headlinePost: string;
  subhead: string;
}

export const HERO_VARIANTS: Record<HeroVariantId, HeroVariantCopy> = {
  A: { id: "A", label: "", headlinePre: "", headlineGradient: "", headlinePost: "", subhead: "" },
  B: { id: "B", label: "", headlinePre: "", headlineGradient: "", headlinePost: "", subhead: "" },
  C: { id: "C", label: "", headlinePre: "", headlineGradient: "", headlinePost: "", subhead: "" },
};

export function isHeroVariantId(value: unknown): value is HeroVariantId {
  return value === "A" || value === "B" || value === "C";
}

export function randomHeroVariant(): HeroVariantId {
  return "A";
}
