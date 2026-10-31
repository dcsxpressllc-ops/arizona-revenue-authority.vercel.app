import "server-only";

import { callAi, aiIsConfigured } from "@/lib/comms/ai/openrouter";
import { firecrawlIsConfigured, scrapeUrl } from "@/lib/firecrawl/client";
import {
  applyBandRhythm,
  repairComparisonItems,
  templateSections,
} from "@/lib/funnels/sections";
import { searchStockImages } from "@/lib/funnels/stock-images";
import {
  MAX_SECTION_ITEMS,
  type FunnelSection,
  type FunnelSectionType,
  type FunnelTemplateKey,
} from "@/types/funnels";

/**
 * AI funnel drafter (the Labs builder's magic wand). Optionally researches a
 * URL with Firecrawl, then drafts the form fields. It only fills the form:
 * nothing is written to Firestore or published, since this copy goes on a
 * public page under the operator's brand.
 *
 * No OpenRouter key: 503. No Firecrawl key or unreadable page: drafts from the
 * description and says so.
 */

export interface AiFunnelDraft {
  name: string;
  ctaSubtitle: string;
  /** Strip above the page. Empty = no banner. */
  topBanner: string;
  sections: FunnelSection[];
  thanksHeadline: string;
  thanksBody: string;
  /** Shown in the UI so the operator knows what the model actually saw. */
  researchNote: string;
}

export class AiDraftError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "AiDraftError";
    this.status = status;
  }
}

/**
 * Copywriting rules. The honesty half matters most: this may be published to
 * real customers, so no invented stats, testimonials, counts, guarantees,
 * prices, awards or timeframes. Bland but true beats punchy and fabricated.
 */
const SYSTEM = `You write short, plain, direct-response landing page copy.

STRUCTURE
- Headline: one specific promise. Concrete outcome, not a slogan. Max 12 words.
- Subheadline: who it's for and what changes for them. One sentence.
- Bullets: 3-5 benefit-led lines. Each states an outcome, not a feature. Max 12 words each.
- CTA label: 2-4 words, action-first ("Get started", "Book a call", "Buy now").
- Thank-you: a short confirmation and what happens next.

STYLE
- Plain English. Short sentences. No hype, no exclamation marks, no emoji.
- Second person ("you"), present tense.
- Specific beats clever. Prefer the concrete noun over the abstract one.
- No jargon the customer wouldn't use themselves.

HONESTY — these are hard rules, not preferences:
- NEVER invent statistics, percentages, customer numbers, revenue figures, ratings or timeframes.
- NEVER invent testimonials, names, logos, awards or press mentions.
- NEVER state or imply a price, discount, guarantee or refund policy.
- NEVER claim results ("double your leads", "in 30 days") unless that exact claim appears in the supplied research.
- If you don't know something, write around it. Vague and true beats specific and invented.

SECTIONS
You are given an ordered list of section types to fill. Write each one:
- hero: heading = the promise, subheading = who it's for, ctaLabel, and
  "badge" — a 2-5 word eyebrow line shown in a pill above the headline (who
  it's for, or a true event detail). Never a fake urgency claim.
- benefits: heading, then items[] where each title is one outcome.
- features: heading, subheading, items[] of {title, body} — what's included.
- testimonials: heading only, and items: []. NEVER invent quotes, names,
  ratings or results. Leave items empty so the operator adds real ones.
- faq: heading, items[] of {title: question, body: answer}. Answer only what you can support.
- offer: heading, subheading, items[] recapping what they get, ctaLabel.
- guarantee: heading + body ONLY if the research states a real guarantee. Otherwise heading:"" and body:"" so it's dropped.
- bio: heading + body about the business, from research only.
- logos: heading only, items: []. Never invent affiliations.
- urgency: leave heading:"" and body:"" unless the research states a real deadline.
- video: leave everything empty — the operator supplies the link.
- image: a full-width photo interlude. Set "imageQuery" and put ONE short
  punchy line in "heading" — a statement, not a claim (e.g. "Training that
  carries into your life."). Leave body empty.
- text: an optional short paragraph.
- cta: heading, subheading, ctaLabel.
- story: THE SPINE OF THE PAGE. heading, an optional one-line subheading, then
  600-900 words of first-person narrative in "body". Tell it like a letter:
  the situation, what went wrong or what changed, what you tried, what you
  found, what it means for the reader. Short paragraphs separated by blank
  lines. This is prose, not bullets. Ground every specific in the research —
  if the research is thin, write a shorter honest story rather than padding it
  with invented detail.
- pricing: heading, subheading, items[] of {title: tier name, meta: the price,
  body: what's included with ONE ITEM PER LINE separated by newlines}. ONLY
  include prices stated in the research. If no prices are known, return
  items: [] and heading:"".
- steps: heading, subheading, items[] of {title: step name, body: what happens}. 3-5 steps.
- stats: heading, items[] of {title: the figure, body: what it measures}. ONLY figures stated in the research — if there are none, return items: [] and heading:"".
- comparison: heading, items[] — ONE item per contrast ROW. In every item,
  title is a FULL SENTENCE describing life WITHOUT this and body is the
  matching FULL SENTENCE describing life WITH it. 3-5 rows. NEVER put labels
  like "Without structure" or "With <brand>" in title or body — the renderer
  prints its own Without/With column headers.
  Example item: {"title":"You chase every invoice by hand.","body":"Invoices send and follow up on themselves."}
- pullquote: body only — one short punchy line in your own words. Not attributed to anyone.

IMAGES
For hero, image and bio sections, set "imageQuery": 2-5 words describing a
photo that would suit it (e.g. "gym barbell training", "team meeting office").
Concrete subjects only — no brand names, no text-in-image, no specific people.
Leave "imageQuery" as "" for every other section type.

LENGTH
A real sales page is long. Do not be terse — the story section alone should be
several hundred words. Short pages read as brochures.

Return ONLY a JSON object, no markdown fence:
{"name":string,"ctaSubtitle":string,"topBanner":string,"thanksHeadline":string,"thanksBody":string,"sections":[{"type":string,"heading":string,"subheading":string,"body":string,"ctaLabel":string,"badge":string,"imageQuery":string,"attribution":string,"items":[{"title":string,"body":string,"meta":string}]}]}
"ctaSubtitle" is one short line that sits under every button — a real detail
like "Starts Monday" or "Cancel any time". Leave "" if you have nothing true to say.
"topBanner" is one short line for the announcement strip above the page — a
true, concrete detail (a date, a location, who it's for). Same honesty rules:
no invented urgency, no fake scarcity. Leave "" when there is nothing true.
Use EXACTLY the section types given, in the same order. Emit every one, even if some fields are empty strings.`;

const TEMPLATE_HINT: Record<FunnelTemplateKey, string> = {
  simple_offer:
    "This is a straight offer page leading to checkout. Lead with the outcome the buyer gets.",
  vsl: "A video sits directly under the headline and carries the pitch. Keep the written copy short — it frames the video, it doesn't repeat it. Bullets say what the video covers.",
  lead_magnet:
    "This is a FREE offer with no purchase. Never imply payment. Emphasise how quick and useful it is to get.",
};

function clamp(v: unknown, max: number): string {
  return String(v ?? "").trim().replace(/\s+/g, " ").slice(0, max);
}

/**
 * Image URLs from scraped markdown. Only real <img> tags survive the scrape
 * (CSS backgrounds don't). https, image extensions, deduped, capped. URLs are
 * hotlinked like stock photos; if the reference site goes down they break,
 * which is acceptable for the operator's own site.
 */
function extractSiteImages(markdown: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re =
    /!\[[^\]]*\]\((https:\/\/[^)\s]+?\.(?:jpe?g|png|webp)(?:\?[^)\s]*)?)\)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null && out.length < 12) {
    const u = m[1];
    if (seen.has(u)) continue;
    seen.add(u);
    // Skip favicons, tracking pixels, tiny icons.
    if (/favicon|sprite|pixel|icon-|-icon|logo-32|badge/i.test(u)) continue;
    out.push(u);
  }
  return out;
}

/** clamp() that keeps paragraph breaks; a story squashed to one line is unreadable. */
function clampProse(v: unknown, max: number): string {
  return String(v ?? "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
}

export async function draftFunnelWithAi(input: {
  subAccountId: string;
  /** Operator's "What are you marketing and selling?" answer. */
  description: string;
  url: string | null;
  template: FunnelTemplateKey;
  /** Used in the copy when the description is thin. */
  businessName: string | null;
}): Promise<AiFunnelDraft> {
  const description = input.description.trim();
  if (!description) {
    throw new AiDraftError("Tell the assistant what you're selling first.");
  }
  if (!aiIsConfigured()) {
    throw new AiDraftError(
      "AI isn't configured on this deployment (OPENROUTER_API_KEY). Fill the form manually, or ask your agency to set it up.",
      503,
    );
  }

  // Research (optional, best-effort)
  let research = "";
  let researchNote = "Drafted from your description only.";
  // The business's own photos beat generic stock, so they're used before Pexels below.
  let siteImages: string[] = [];
  const url = (input.url ?? "").trim();
  if (url) {
    if (!firecrawlIsConfigured()) {
      researchNote =
        "Drafted from your description only — website research isn't configured on this deployment (FIRECRAWL_API_KEY).";
    } else {
      try {
        const withScheme = /^https?:\/\//i.test(url) ? url : `https://${url}`;
        const page = await scrapeUrl(withScheme, { subAccountId: input.subAccountId });
        // Extract from the full markdown before the 5,000-char prompt slice, or later image links are lost.
        const fullMarkdown = page.markdown ?? "";
        siteImages = extractSiteImages(fullMarkdown);
        const markdown = fullMarkdown.slice(0, 5_000);
        if (markdown.trim()) {
          research = markdown;
          researchNote = `Researched ${page.title ? `"${page.title}"` : withScheme}.${
            siteImages.length
              ? ` Found ${siteImages.length} photo${siteImages.length === 1 ? "" : "s"} on the site and used them for image sections.`
              : ""
          }`;
        } else {
          researchNote =
            "Couldn't read anything useful from that page — drafted from your description instead.";
        }
      } catch {
        // Paywalls, bot walls and 404s are normal; never fail the draft over research.
        researchNote =
          "Couldn't reach that page — drafted from your description instead.";
      }
    }
  }

  const wanted = templateSections(input.template);

  const userParts = [
    `WHAT THEY'RE SELLING: ${description}`,
    `SECTIONS TO WRITE, IN ORDER: ${wanted.join(", ")}`,
    input.businessName ? `BUSINESS NAME: ${input.businessName}` : null,
    `PAGE TYPE: ${TEMPLATE_HINT[input.template]}`,
    research
      ? `RESEARCH — content scraped from their real website. Use it for facts, tone and the services they actually offer. Do not quote it verbatim and do not treat marketing puffery in it as proof:\n\n${research}`
      : "No website research available. Work from the description. Stay general rather than inventing specifics.",
  ].filter(Boolean);

  let raw: string;
  try {
    const res = await callAi({
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: userParts.join("\n\n") },
      ],
      maxTokens: 6_000,
      temperature: 0.7,
      meter: { subAccountId: input.subAccountId, source: "other" },
    });
    raw = res.text;
  } catch (err) {
    console.error("[funnels/ai-draft] LLM call failed", err);
    throw new AiDraftError(
      "The assistant couldn't be reached. Try again in a moment.",
      502,
    );
  }

  // Models sometimes fence the JSON anyway.
  const jsonText = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonText) as Record<string, unknown>;
  } catch {
    console.warn("[funnels/ai-draft] unparseable model output", jsonText.slice(0, 300));
    throw new AiDraftError(
      "The assistant returned something unexpected. Try again, or fill the form manually.",
      502,
    );
  }

  // Use the requested order, not the model's (it sometimes drops or reorders).
  // Missing sections come back empty for the operator rather than vanishing.
  const returned = Array.isArray(parsed.sections)
    ? (parsed.sections as Record<string, unknown>[])
    : [];
  const sections: FunnelSection[] = wanted.map((type, i) => {
    const raw =
      returned.find((r) => String(r?.type ?? "") === type) ?? returned[i] ?? {};
    let items = Array.isArray(raw.items)
      ? (raw.items as Record<string, unknown>[])
          .slice(0, MAX_SECTION_ITEMS)
          .map((it) => ({
            title: clamp(it?.title, 200),
            body: clampProse(it?.body, 800),
            meta: clamp(it?.meta, 300),
          }))
          .filter((it) => it.title || it.body)
      : [];
    // Models sometimes emit label/description pairs for comparison items; repair them.
    if (type === "comparison") items = repairComparisonItems(items);
    return {
      id: `ai${i}`,
      type: type as FunnelSectionType,
      heading: clamp(raw.heading, 160),
      subheading: clamp(raw.subheading, 400),
      body: clampProse(raw.body, 6_000),
      items,
      // Never from the model: LLM URLs tend to 404. Photos come from imageQuery below.
      mediaUrl: null,
      ctaLabel: clamp(raw.ctaLabel, 60),
      deadline: null,
      imageQuery: clamp(raw.imageQuery, 120),
      attribution: clamp(raw.attribution, 120),
      badge: clamp(raw.badge, 60),
      mediaAsBackground: false,
      // Long-form reads badly centred.
      alignLeft: type === "story",
      compareAt: "",
      scarcityPercent: null,
    };
  });

  // Site photos first, in page order (the hero tends to be the best), then stock
  // search for the rest.
  let siteIdx = 0;
  for (const sec of sections) {
    if (!sec.imageQuery) continue;
    if (siteIdx < siteImages.length) {
      sec.mediaUrl = siteImages[siteIdx];
      siteIdx += 1;
    }
  }

  // Best-effort and parallel. The brief stays on the section so the operator can re-search later.
  await Promise.all(
    sections.map(async (sec) => {
      if (!sec.imageQuery || sec.mediaUrl) return;
      const hits = await searchStockImages(sec.imageQuery, 1);
      if (hits[0]) sec.mediaUrl = hits[0].url;
    }),
  );

  // Hero/interlude with a photo uses it full-bleed; the renderer forces a dark
  // overlay so any image works. Operator can untick it.
  for (const sec of sections) {
    if ((sec.type === "hero" || sec.type === "image") && sec.mediaUrl) {
      sec.mediaAsBackground = true;
    }
  }

  return {
    name: clamp(parsed.name, 120) || description.slice(0, 60),
    ctaSubtitle: clamp(parsed.ctaSubtitle, 80),
    topBanner: clamp(parsed.topBanner, 120),
    // Bands are assigned deterministically; an alternating rhythm reads well and LLM colour picks don't.
    sections: applyBandRhythm(sections),
    thanksHeadline: clamp(parsed.thanksHeadline, 160) || "Thank you",
    thanksBody: clamp(parsed.thanksBody, 800),
    researchNote,
  };
}
