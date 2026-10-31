import {
  parsePhoneNumberFromString,
  type CountryCode,
} from "libphonenumber-js";

/**
 * Phone normalization for contact write paths. Storing numbers as typed
 * breaks dedupe ("(305) 555-1234" vs "+13055551234" become two contacts, and
 * voice splits a booking and a call), fails `isValid()` at parse sites that
 * pass no default country (so the outbound-voice compliance gate won't dial),
 * and lets junk like "78893" through.
 *
 * `defaultPhoneCountry` (default US) is only a fallback for national numbers;
 * a leading "+" always parses as its own country.
 *
 * Public forms use normalizePhoneE164 and reject null (the visitor can fix
 * it). Import, manual entry and booking use normalizePhoneLenient so one bad
 * cell never drops a row. Client-safe for inline form validation.
 */

export const DEFAULT_PHONE_COUNTRY: CountryCode = "US";

/** Coerces a stored value ("us", " AU ", junk, null) to a CountryCode. */
export function coercePhoneCountry(country?: string | null): CountryCode {
  const c = country?.trim().toUpperCase();
  return c && /^[A-Z]{2}$/.test(c)
    ? (c as CountryCode)
    : DEFAULT_PHONE_COUNTRY;
}

/** `+13055551234` when valid, else null. */
export function normalizePhoneE164(
  raw: string | null | undefined,
  country?: string | null,
): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const parsed = parsePhoneNumberFromString(s, coercePhoneCountry(country));
  return parsed?.isValid() ? parsed.number : null;
}

/** E.164 when possible, else the trimmed input ("" for empty). For paths that must never drop a record. */
export function normalizePhoneLenient(
  raw: string | null | undefined,
  country?: string | null,
): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  return normalizePhoneE164(s, country) ?? s;
}
