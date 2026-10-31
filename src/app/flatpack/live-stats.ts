// Hello world
export type LiveBuyerTotals = { countries: number; cities: number; continents: number };

export async function getLiveBuyerTotals(): Promise<LiveBuyerTotals | null> {
  return null;
}

export function withLiveStats<T>(stats: readonly T[], live: LiveBuyerTotals | null): T[] {
  void live;
  return [...stats];
}

export function fillCountries(text: string, live: LiveBuyerTotals | null, fallback: string): string {
  void live;
  return text.replace("{countries}", fallback);
}
