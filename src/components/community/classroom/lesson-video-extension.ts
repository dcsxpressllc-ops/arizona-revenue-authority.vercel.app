import { Node } from "@tiptap/core";
import { embedUrlFor } from "@/lib/community/video-embed";
import type { VideoProvider } from "@/types/community";

/**
 * TipTap block node for an inline YouTube/Vimeo player. Stored as
 * <div class="lesson-video" data-provider data-id><iframe ...></div>; the
 * sanitizer (lesson-html.ts) only keeps the iframe for known embed hosts.
 */

const ALLOW =
  "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    lessonVideo: {
      setLessonVideo: (attrs: {
        provider: VideoProvider;
        videoId: string;
      }) => ReturnType;
    };
  }
}

export const LessonVideo = Node.create({
  name: "lessonVideo",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      provider: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-provider"),
        renderHTML: () => ({}),
      },
      videoId: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-id"),
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [{ tag: "div.lesson-video" }];
  },

  renderHTML({ node }) {
    const provider = node.attrs.provider as VideoProvider | null;
    const videoId = node.attrs.videoId as string | null;
    return [
      "div",
      {
        class: "lesson-video",
        "data-provider": provider ?? "",
        "data-id": videoId ?? "",
      },
      [
        "iframe",
        {
          src: embedUrlFor(provider, videoId) ?? "",
          allow: ALLOW,
          allowfullscreen: "true",
          frameborder: "0",
        },
      ],
    ];
  },

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("div");
      dom.className = "lesson-video";
      dom.setAttribute("data-provider", node.attrs.provider ?? "");
      dom.setAttribute("data-id", node.attrs.videoId ?? "");
      const iframe = document.createElement("iframe");
      iframe.src = embedUrlFor(node.attrs.provider, node.attrs.videoId) ?? "";
      iframe.setAttribute("allow", ALLOW);
      iframe.setAttribute("allowfullscreen", "true");
      iframe.setAttribute("frameborder", "0");
      // Don't let the iframe swallow clicks, so the node stays selectable/deletable.
      iframe.style.pointerEvents = "none";
      dom.appendChild(iframe);
      return { dom };
    };
  },

  addCommands() {
    return {
      setLessonVideo:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({ type: "lessonVideo", attrs }),
    };
  },
});
