import { emptySection, repairComparisonItems } from "@/lib/funnels/sections";
import {
  MAX_FUNNEL_SECTIONS,
  MAX_SECTION_ITEMS,
  type FunnelSection,
  type FunnelSectionType,
  type FunnelStyle,
} from "@/types/funnels";

/**
 * AI edit ops: the wire format between the edit-draft route and the builder,
 * plus a pure applier. Ops rather than full rewrites, so untouched sections
 * stay untouched and a "change the button text" request doesn't round-trip a
 * 900-word story through the model.
 *
 * Client-safe: the builder applies ops locally for review before save. The
 * server sanitizer re-validates on save, so light coercion is enough here.
 */

const SECTION_TYPES = new Set<FunnelSectionType>([
  "hero", "video", "benefits", "features", "testimonials", "faq", "offer",
  "guarantee", "bio", "logos", "urgency", "text", "image", "cta",
  "steps", "stats", "comparison", "pullquote", "story", "pricing",
]);

/** `mediaUrl` deliberately excluded: model URLs tend to 404. Images come from `imageQuery` or the operator. */
const EDITABLE_FIELDS = [
  "heading", "subheading", "body", "ctaLabel", "badge", "background",
  "alignLeft", "imageQuery", "deadline", "compareAt", "scarcityPercent",
  "attribution", "mediaAsBackground", "items",
] as const;

export interface AiSectionPatch {
  heading?: string;
  subheading?: string;
  body?: string;
  ctaLabel?: string;
  badge?: string;
  background?: FunnelSection["background"];
  alignLeft?: boolean;
  imageQuery?: string;
  deadline?: string | null;
  compareAt?: string;
  scarcityPercent?: number | null;
  attribution?: string;
  mediaAsBackground?: boolean;
  items?: { title?: string; body?: string; meta?: string; result?: string; rating?: number | null }[];
  /** insertSection only. */
  type?: FunnelSectionType;
  /** Stock photo resolved server-side; never set by the model. */
  mediaUrl?: string | null;
}

export type AiEditOp =
  | { op: "updateSection"; id: string; fields: AiSectionPatch }
  | { op: "insertSection"; after: string | "start" | "end"; section: AiSectionPatch }
  | { op: "removeSection"; id: string }
  | { op: "moveSection"; id: string; after: string | "start" | "end" }
  | {
      op: "setPage";
      fields: {
        ctaSubtitle?: string;
        topBanner?: string;
        stickyCta?: boolean;
        thanksHeadline?: string;
        thanksBody?: string;
      };
    }
  | { op: "setStyle"; fields: Partial<FunnelStyle> };

export interface AiEditPageState {
  sections: FunnelSection[];
  thanksHeadline: string;
  thanksBody: string;
  ctaSubtitle: string;
  topBanner: string;
  stickyCta: boolean;
  style: FunnelStyle;
}

function coerceItems(
  raw: AiSectionPatch["items"],
): FunnelSection["items"] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw
    .slice(0, MAX_SECTION_ITEMS)
    .map((it) => ({
      title: String(it?.title ?? "").slice(0, 200),
      body: String(it?.body ?? "").slice(0, 800),
      meta: String(it?.meta ?? "").slice(0, 300),
      result: String(it?.result ?? "").slice(0, 80),
      rating:
        typeof it?.rating === "number" && it.rating > 0
          ? Math.min(5, Math.round(it.rating))
          : null,
      imageUrl: null,
    }))
    .filter((it) => it.title || it.body);
}

function mergePatch(base: FunnelSection, patch: AiSectionPatch): FunnelSection {
  const next = { ...base };
  for (const key of EDITABLE_FIELDS) {
    if (patch[key] === undefined) continue;
    if (key === "items") {
      const items = coerceItems(patch.items);
      if (items) {
        // Repair label/description pairs on comparison items.
        next.items =
          next.type === "comparison" ? repairComparisonItems(items) : items;
      }
    } else {
      // @ts-expect-error: key-indexed assignment across a checked field list.
      next[key] = patch[key];
    }
  }
  return next;
}

function labelOf(s: { type?: string; heading?: string }): string {
  return s.heading ? `"${String(s.heading).slice(0, 40)}"` : (s.type ?? "section");
}

/**
 * Pure. Returns the new state plus summary lines for the operator. Unknown
 * ids and invalid ops become "skipped" lines instead of throwing, so one bad
 * op doesn't discard the good ones.
 */
export function applyAiEditOps(
  state: AiEditPageState,
  ops: AiEditOp[],
): { state: AiEditPageState; summary: string[] } {
  let sections = [...state.sections];
  const next: AiEditPageState = { ...state, sections };
  const summary: string[] = [];

  const place = (arr: FunnelSection[], sec: FunnelSection, after: string | "start" | "end") => {
    if (after === "start") return [sec, ...arr];
    if (after === "end") return [...arr, sec];
    const i = arr.findIndex((x) => x.id === after);
    if (i < 0) return [...arr, sec];
    return [...arr.slice(0, i + 1), sec, ...arr.slice(i + 1)];
  };

  for (const op of ops) {
    switch (op.op) {
      case "updateSection": {
        const i = sections.findIndex((x) => x.id === op.id);
        if (i < 0) {
          summary.push(`Skipped an update — no section "${op.id}".`);
          break;
        }
        sections[i] = mergePatch(sections[i], op.fields);
        summary.push(`Updated ${sections[i].type} ${labelOf(sections[i])}.`);
        break;
      }
      case "insertSection": {
        if (sections.length >= MAX_FUNNEL_SECTIONS) {
          summary.push("Skipped an insert — section limit reached.");
          break;
        }
        const type = SECTION_TYPES.has(op.section.type as FunnelSectionType)
          ? (op.section.type as FunnelSectionType)
          : "text";
        const base = emptySection(type, `ai${Date.now().toString(36)}${sections.length}`);
        let sec = mergePatch(base, op.section);
        // Exception to the mediaUrl rule: the route resolves imageQuery to a real stock URL first.
        if (typeof op.section.mediaUrl === "string") {
          sec = { ...sec, mediaUrl: op.section.mediaUrl };
        }
        sections = place(sections, sec, op.after ?? "end");
        summary.push(`Added a ${type} section.`);
        break;
      }
      case "removeSection": {
        const found = sections.find((x) => x.id === op.id);
        if (!found) {
          summary.push(`Skipped a removal — no section "${op.id}".`);
          break;
        }
        sections = sections.filter((x) => x.id !== op.id);
        summary.push(`Removed ${found.type} ${labelOf(found)}.`);
        break;
      }
      case "moveSection": {
        const found = sections.find((x) => x.id === op.id);
        if (!found) {
          summary.push(`Skipped a move — no section "${op.id}".`);
          break;
        }
        sections = place(
          sections.filter((x) => x.id !== op.id),
          found,
          op.after ?? "end",
        );
        summary.push(`Moved ${found.type} ${labelOf(found)}.`);
        break;
      }
      case "setPage": {
        const f = op.fields ?? {};
        if (typeof f.ctaSubtitle === "string") {
          next.ctaSubtitle = f.ctaSubtitle.slice(0, 80);
          summary.push("Updated the button subtitle.");
        }
        if (typeof f.topBanner === "string") {
          next.topBanner = f.topBanner.slice(0, 120);
          summary.push(
            f.topBanner ? "Updated the top banner." : "Removed the top banner.",
          );
        }
        if (typeof f.stickyCta === "boolean") {
          next.stickyCta = f.stickyCta;
          summary.push(f.stickyCta ? "Enabled the sticky bar." : "Disabled the sticky bar.");
        }
        if (typeof f.thanksHeadline === "string") {
          next.thanksHeadline = f.thanksHeadline.slice(0, 160);
          summary.push("Updated the thank-you headline.");
        }
        if (typeof f.thanksBody === "string") {
          next.thanksBody = f.thanksBody.slice(0, 800);
          summary.push("Updated the thank-you message.");
        }
        break;
      }
      case "setStyle": {
        const f = op.fields ?? {};
        next.style = {
          ...next.style,
          ...(f.fontPair ? { fontPair: f.fontPair } : {}),
          ...(typeof f.headingScale === "number"
            ? { headingScale: Math.min(Math.max(f.headingScale, 0.7), 1.8) }
            : {}),
          ...(typeof f.uppercaseHeadings === "boolean"
            ? { uppercaseHeadings: f.uppercaseHeadings }
            : {}),
          ...(typeof f.contentWidth === "number"
            ? { contentWidth: Math.min(Math.max(Math.round(f.contentWidth), 560), 1100) }
            : {}),
        };
        summary.push("Updated the page style.");
        break;
      }
      default:
        summary.push("Skipped an unrecognised operation.");
    }
  }

  next.sections = sections;
  return { state: next, summary };
}
