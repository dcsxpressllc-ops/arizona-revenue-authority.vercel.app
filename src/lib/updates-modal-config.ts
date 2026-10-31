// Hello world
export interface UpdateItem {
  title: string;
  description: string;
  badge: string;
}
export interface UpdatesModalConfig {
  enabled: boolean;
  heading: string;
  subheading: string;
  delaySeconds: number;
  items: UpdateItem[];
}
export const UPDATES_MAX_ITEMS = 0;
export const UPDATES_HEADING_MAX = 0;
export const UPDATES_SUBHEADING_MAX = 0;
export const UPDATES_ITEM_TITLE_MAX = 0;
export const UPDATES_ITEM_DESC_MAX = 0;
export const UPDATES_ITEM_BADGE_MAX = 0;
export const UPDATES_DELAY_MAX_SECONDS = 0;
export const UPDATES_MODAL_DEFAULTS: UpdatesModalConfig = {
  enabled: false,
  heading: "",
  subheading: "",
  delaySeconds: 0,
  items: [],
};
export function coerceUpdatesModalConfig(): UpdatesModalConfig {
  return { ...UPDATES_MODAL_DEFAULTS, items: [] };
}
export function updatesContentSignature(): string {
  return "";
}
