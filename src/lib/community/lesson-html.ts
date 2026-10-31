import sanitizeHtml from "sanitize-html";
import { lessonBodyToEditorHtml } from "./lesson-html-shared";

export {
  isHtml,
  plainTextToHtml,
  lessonBodyToEditorHtml,
} from "./lesson-html-shared";

/**
 * Server-side lesson body sanitizing. Bodies come from staff's TipTap editor
 * and are shown to members who may be in another tenant, so they're always
 * sanitized at render; never trust stored HTML on the way out.
 *
 * Keeps standard formatting, headings, lists, blockquote, code, <img>, <a>,
 * and <iframe> only for YouTube/Vimeo embeds (the `lesson-video` node).
 * Pulls in sanitize-html, so keep it off the client path; client components
 * use ./lesson-html-shared.
 */

const SAFE_IFRAME_SRC =
  /^https:\/\/(www\.youtube\.com\/embed\/|player\.vimeo\.com\/video\/)/;

/** Server-side (no DOM). */
export function sanitizeLessonHtml(html: string): string {
  if (!html) return "";
  return sanitizeHtml(html, {
    allowedTags: [
      "p", "br", "strong", "em", "u", "s", "del", "code", "pre",
      "blockquote", "h1", "h2", "h3", "h4", "ul", "ol", "li",
      "a", "img", "hr", "iframe", "div", "span", "figure",
    ],
    allowedAttributes: {
      a: ["href", "target", "rel"],
      img: ["src", "alt", "title", "class"],
      iframe: ["src", "allow", "allowfullscreen", "frameborder"],
      div: ["class", "data-provider", "data-id"],
      span: ["class"],
      "*": ["class"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: ["http", "https"], iframe: ["https"] },
    // Known host and known embed path.
    allowedIframeHostnames: ["www.youtube.com", "player.vimeo.com"],
    exclusiveFilter: (frame) =>
      frame.tag === "iframe" && !SAFE_IFRAME_SRC.test(frame.attribs.src ?? ""),
    transformTags: {
      a: (tagName, attribs) => ({
        tagName: "a",
        attribs: {
          ...attribs,
          target: "_blank",
          rel: "noopener noreferrer nofollow",
        },
      }),
    },
  });
}

/** Stored body -> sanitized HTML for the player. */
export function renderLessonBodyHtml(body: string | null | undefined): string {
  return sanitizeLessonHtml(lessonBodyToEditorHtml(body));
}
