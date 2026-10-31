/**
 * Data for each /leadstack-vs-{slug} page; route, components and JSON-LD all
 * read from it. New competitor: add src/data/comparisons/{slug}.ts, register
 * it in index.ts, and link it from the landing footer. Route and sitemap pick
 * it up via generateStaticParams.
 */
/**
 * Cost model behind the scenario calculator. Every figure must match the same
 * page's prose `pricing` notes; the calculator is never a separate source of
 * numbers. Slot-based (base + optional addon/toggle/one-time) so the two cost
 * cards stay row-aligned. Omit `calculator` to hide the section.
 */
export type ComparisonCalculatorConfig = {
  heading: string;
  intro: string;
  /** Competitor cost card title; short name reads best. */
  competitorTitle: string;
  /** "How many clients" slider. Omit for flat-priced competitors; per-unit lines then multiply by 1. */
  unit?: {
    sliderLabel: string;
    min: number;
    max: number;
    defaultValue: number;
  };
  /** Competitor platform subscription. Always present. */
  base: {
    label: string;
    monthly: number;
    /** "unit" multiplies by the unit slider. */
    per: "flat" | "unit";
    hint?: string;
    /** Hint under the LeadStack "License (one-time)" row. */
    leadstackHint?: string;
  };
  /** Per-seat / per-portal monthly addon slider. */
  addon?: {
    sliderLabel: string;
    /** Count is appended. */
    lineLabel: string;
    monthlyPerUnit: number;
    defaultValue: number;
    /** Cap at the unit slider's value (e.g. AI per sub-account). Otherwise `max` applies. */
    clampToUnit?: boolean;
    max?: number;
    hint?: string;
    leadstack: { label: string; hint?: string };
  };
  /** Flat monthly add-on, e.g. premium support. */
  toggle?: {
    label: string;
    description: string;
    monthly: number;
    defaultOn: boolean;
    hint?: string;
    leadstack: { label: string; hint?: string };
  };
  /** e.g. mandatory onboarding. */
  oneTime?: {
    label: string;
    amount: number;
    per: "flat" | "unit";
    hint?: string;
    leadstack: { label: string; hint?: string };
  };
  /** Sentence after the payback line. */
  paybackNote: string;
};

export type ComparisonCostScenario = {
  heading: string;
  /** Assumptions in plain words. */
  intro: string;
  /** Month + year the competitor's prices were checked. */
  asOf: string;
  months: number;
  /** Client sub-accounts modelled. */
  clients: number;
  /** "unit" multiplies by `clients`. */
  competitorLines: Array<{
    label: string;
    monthly: number;
    per: "flat" | "unit";
    note?: string;
  }>;
  /** Monthly amounts are multiplied by `months`. */
  leadstackLines: Array<{
    label: string;
    amount: number;
    kind: "one-time" | "monthly";
    note?: string;
  }>;
  /** Left out of both columns (e.g. usage billed either way). */
  excluded: string[];
  /** Table source line. */
  sourceLabel: string;
  sourceUrl: string;
};

export type Comparison = {
  /** /leadstack-vs-{slug}. Lowercase, hyphenated. */
  slug: string;
  competitorName: string;
  /** For table headers and other tight spots. */
  competitorShortName?: string;
  /** Ideally <= 60 chars. */
  metaTitle: string;
  /** ~155 chars. */
  metaDescription: string;
  /** Shown in the legal disclaimer. */
  lastVerifiedDate: string;
  hero: {
    h1: string;
    subhead: string;
    ctaLabel: string;
  };
  pullQuote: {
    text: string;
    author: string;
    role?: string;
  };
  painPoints: {
    heading: string;
    bullets: Array<{
      title: string;
      body: string;
    }>;
  };
  advantages: Array<{
    title: string;
    body: string;
  }>;
  featureTable: {
    heading: string;
    rows: Array<{
      label: string;
      /** A divider renders when this differs from the previous row's. Unset everywhere = flat table. */
      category?: string;
      /** Adds a numbered superscript; text is listed under the table. */
      footnote?: string;
      /** true = check, false = X, string = note (e.g. "Add-on $X/mo"). */
      leadstack: boolean | string;
      competitor: boolean | string;
    }>;
  };
  pricing: {
    heading: string;
    leadstack: {
      headline: string;
      detail: string;
      notes: string[];
    };
    competitor: {
      headline: string;
      detail: string;
      notes: string[];
    };
    summary: string;
  };
  /** Honest "where they win" section. Omit to hide. */
  competitorWins?: {
    heading: string;
    bullets: string[];
    closing: string;
  };
  /** Also feeds FAQPage JSON-LD. */
  faq: {
    heading: string;
    items: Array<{
      question: string;
      answer: string;
    }>;
  };
  calculator?: ComparisonCalculatorConfig;
  /**
   * Static <table> version of the calculator. The calculator is client-side
   * and invisible to crawlers/AI engines; this is the quotable, sourced copy.
   * Omit to hide.
   */
  costScenario?: ComparisonCostScenario;
  finalCta: {
    headline: string;
    body: string;
    primaryCtaLabel: string;
    primaryCtaHref: string;
  };
};
