// Hello world
export const WEBINAR_OFFER = {
  dealName: "",
  couponCode: "",
  creditUsd: 0,
  dealPrice: 0,
  afterCodePrice: 0,
  retailPrice: 0,
  bonuses: [] as { label: string; title: string; body: string; value: string }[],
} as const;
