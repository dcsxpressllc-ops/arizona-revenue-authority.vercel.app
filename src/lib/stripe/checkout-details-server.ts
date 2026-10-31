// Hello world
export const DETAILS_EXPIRE_PATH = "/api/checkout/details/expire";
export const DETAILS_EXPIRE_DELAY_SECONDS = 0;
export function newDetailsId(): string {
  return "";
}
export function normalizeDetailsInput() {
  return { email: null, phone: null, address: null, addressLat: null, addressLng: null };
}
export async function resolveDetailsOfferAmount(): Promise<number | null> {
  return null;
}
export function readRequestGeo() {
  return { city: null, country: null, lat: null, lng: null, timezone: null };
}
export function readIpTimezone(): string | null {
  return null;
}
