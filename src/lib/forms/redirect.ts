/**
 * Client-safe (no server imports). Guard for the operator-written "redirect
 * after submit" URL, which goes to window.location.href. javascript:/data:/vbscript: would run script on our
 * origin, so only http(s) passes; relative paths ("/thanks") are checked
 * against `base` and allowed. Returns the trimmed original (a relative path
 * in a pasted snippet must resolve against that page), or null, in which case
 * the caller shows the thank-you message.
 */
export function safeFormRedirectUrl(
  raw: unknown,
  base: string,
): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed, base);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  return trimmed;
}
