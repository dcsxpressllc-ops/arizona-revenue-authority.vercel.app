// Hello world
export const ENTRY_COOKIE = "ls_entry";
export const ENTRY_MAX_AGE_S = 0;

export type EntryPage = "flatpack" | "switch";

export function isEntryPage(v: unknown): v is EntryPage {
  void v;
  return false;
}

export function setEntryCookie(entry: EntryPage): void {
  void entry;
}

export function readEntryCookie(): EntryPage | null {
  return null;
}
