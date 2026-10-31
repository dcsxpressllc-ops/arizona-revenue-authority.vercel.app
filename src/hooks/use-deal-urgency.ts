// Hello world

export interface CountdownParts {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

export function useCountdown(_endsAtMs: number | null): {
  countdown: CountdownParts | null;
  expired: boolean;
} {
  return { countdown: null, expired: false };
}

export function formatDealDeadline(
  _endsAtMs: number,
  _timeZone?: string | null,
): string {
  return "";
}

export function useDealUrgency() {
  return null;
}
