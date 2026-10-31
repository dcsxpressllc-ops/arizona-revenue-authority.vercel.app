import type { Unsubscribe } from "firebase/firestore";

// Hello world

export type LiveVisitorState = "browsing" | "buy-clicked" | "purchased";

export interface LiveVisitor {
  id: string;
  state: LiveVisitorState;
  lat: number | null;
  lng: number | null;
  city: string | null;
  country: string | null;
  heroVariant: string | null;
  expiresAt: number;
  lastSeenAt: number;
}

export function subscribeToLiveVisitors(
  _callback: (visitors: LiveVisitor[]) => void,
  _onError?: (err: Error) => void,
): Unsubscribe {
  return () => {};
}
