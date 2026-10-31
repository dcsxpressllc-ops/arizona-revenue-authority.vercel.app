/**
 * Video embed normalisation for funnel pages. This is a security check: the
 * URL goes into an <iframe> on a page we host, so hosts are allow-listed and
 * the embed URL is rebuilt from the extracted id. Anything that doesn't parse
 * into a known shape is rejected. Client-safe so the builder previews exactly
 * what gets stored.
 */

export interface VideoEmbed {
  /** Rebuilt, safe embed URL. */
  url: string;
  provider: "youtube" | "vimeo" | "loom" | "wistia";
}

/** null unless it's a recognised embeddable video. */
export function normaliseVideoUrl(raw: string): VideoEmbed | null {
  const input = raw.trim();
  if (!input) return null;

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;

  const host = parsed.hostname.replace(/^www\./, "").toLowerCase();

  // YouTube
  if (host === "youtube.com" || host === "m.youtube.com") {
    const id = parsed.searchParams.get("v");
    if (id && /^[\w-]{6,20}$/.test(id)) {
      return { url: `https://www.youtube.com/embed/${id}`, provider: "youtube" };
    }
    const embedMatch = parsed.pathname.match(/^\/embed\/([\w-]{6,20})$/);
    if (embedMatch) {
      return {
        url: `https://www.youtube.com/embed/${embedMatch[1]}`,
        provider: "youtube",
      };
    }
    return null;
  }
  if (host === "youtu.be") {
    const id = parsed.pathname.replace(/^\//, "");
    if (/^[\w-]{6,20}$/.test(id)) {
      return { url: `https://www.youtube.com/embed/${id}`, provider: "youtube" };
    }
    return null;
  }

  // Vimeo
  if (host === "vimeo.com" || host === "player.vimeo.com") {
    const id = parsed.pathname.match(/(\d{6,})/)?.[1];
    if (id) {
      return { url: `https://player.vimeo.com/video/${id}`, provider: "vimeo" };
    }
    return null;
  }

  // Loom
  if (host === "loom.com") {
    const id = parsed.pathname.match(/\/(?:share|embed)\/([0-9a-f]{16,})/i)?.[1];
    if (id) {
      return { url: `https://www.loom.com/embed/${id}`, provider: "loom" };
    }
    return null;
  }

  // Wistia
  if (host.endsWith("wistia.com") || host.endsWith("wistia.net")) {
    const id = parsed.pathname.match(/\/(?:medias|embed\/iframe)\/([\w-]{8,})/)?.[1];
    if (id) {
      return {
        url: `https://fast.wistia.net/embed/iframe/${id}`,
        provider: "wistia",
      };
    }
    return null;
  }

  return null;
}

export const VIDEO_HELP =
  "Paste a YouTube, Vimeo, Loom or Wistia link. Other hosts are rejected — the video is embedded on your public page, so we only allow known providers.";
