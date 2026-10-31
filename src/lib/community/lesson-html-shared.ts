/**
 * Client-safe lesson-body helpers with no sanitizer dependency, so the editor
 * doesn't pull a parser into the bundle. The sanitizing path is lesson-html.ts.
 * Older bodies are plain text in the same `bodyHtml` field; these upgrade them
 * to paragraphs so newlines survive.
 */

/** HTML vs legacy plain text. */
export function isHtml(s: string): boolean {
  return /<[a-z][\s\S]*>/i.test(s);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Plain text -> paragraph HTML, keeping newlines. */
export function plainTextToHtml(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return trimmed
    .split(/\n{2,}/)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/** Editor-ready HTML. Not sanitized (staff editing their own content); the player sanitizes on render. */
export function lessonBodyToEditorHtml(body: string | null | undefined): string {
  const s = (body ?? "").trim();
  if (!s) return "";
  return isHtml(s) ? s : plainTextToHtml(s);
}
