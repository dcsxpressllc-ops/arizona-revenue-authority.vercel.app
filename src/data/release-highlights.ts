import type { UpdateItem } from "@/lib/updates-modal-config";

export interface ReleaseHighlight {
  title: string;
  badge: "New" | "Improved";
  description: string;
  score: number;
}

export interface ReleaseNotes {
  version: string;
  date: string;
  highlights: ReleaseHighlight[];
}

export const RELEASE_NOTES: ReleaseNotes[] = [];

export function suggestReleaseHighlights(
  _count = 6,
  _releases = 5,
): (UpdateItem & { version: string })[] {
  return [];
}
