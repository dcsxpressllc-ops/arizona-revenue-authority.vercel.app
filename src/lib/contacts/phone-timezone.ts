import { parsePhoneNumberFromString } from "libphonenumber-js";

/**
 * Country code -> one representative IANA zone, for checking the outbound
 * calling window in the contact's local time when all we have is a phone.
 * Approximate for multi-zone countries (US, AU, RU, BR, CA...), where the
 * check can be off by a few hours at the edges; exact for single-zone ones.
 * Missing codes use the caller's fallback.
 */
const COUNTRY_TZ: Record<string, string> = {
  AU: "Australia/Sydney",
  NZ: "Pacific/Auckland",
  US: "America/Chicago", // central as a middle-ground across US zones
  CA: "America/Toronto",
  GB: "Europe/London",
  IE: "Europe/Dublin",
  FR: "Europe/Paris",
  DE: "Europe/Berlin",
  ES: "Europe/Madrid",
  IT: "Europe/Rome",
  NL: "Europe/Amsterdam",
  BE: "Europe/Brussels",
  CH: "Europe/Zurich",
  AT: "Europe/Vienna",
  SE: "Europe/Stockholm",
  NO: "Europe/Oslo",
  DK: "Europe/Copenhagen",
  FI: "Europe/Helsinki",
  PT: "Europe/Lisbon",
  PL: "Europe/Warsaw",
  CZ: "Europe/Prague",
  GR: "Europe/Athens",
  RO: "Europe/Bucharest",
  ZA: "Africa/Johannesburg",
  NG: "Africa/Lagos",
  KE: "Africa/Nairobi",
  EG: "Africa/Cairo",
  AE: "Asia/Dubai",
  SA: "Asia/Riyadh",
  IL: "Asia/Jerusalem",
  IN: "Asia/Kolkata",
  PK: "Asia/Karachi",
  BD: "Asia/Dhaka",
  SG: "Asia/Singapore",
  MY: "Asia/Kuala_Lumpur",
  ID: "Asia/Jakarta",
  PH: "Asia/Manila",
  TH: "Asia/Bangkok",
  VN: "Asia/Ho_Chi_Minh",
  HK: "Asia/Hong_Kong",
  JP: "Asia/Tokyo",
  KR: "Asia/Seoul",
  CN: "Asia/Shanghai",
  TR: "Europe/Istanbul",
  RU: "Europe/Moscow",
  BR: "America/Sao_Paulo",
  AR: "America/Argentina/Buenos_Aires",
  MX: "America/Mexico_City",
  CL: "America/Santiago",
  CO: "America/Bogota",
  PE: "America/Lima",
};

/** Falls back to `fallbackTz` (sub-account/agent zone) if unparseable or not in the table. */
export function timezoneForPhone(
  phone: string | null | undefined,
  fallbackTz: string,
): string {
  if (!phone) return fallbackTz;
  try {
    const parsed = parsePhoneNumberFromString(phone);
    const code = parsed?.country;
    if (code && COUNTRY_TZ[code]) return COUNTRY_TZ[code];
  } catch {
    // fall through to fallback
  }
  return fallbackTz;
}

/** null if unparseable. For the country allow-list compliance check. */
export function countryForPhone(
  phone: string | null | undefined,
): string | null {
  if (!phone) return null;
  try {
    return parsePhoneNumberFromString(phone)?.country ?? null;
  } catch {
    return null;
  }
}
