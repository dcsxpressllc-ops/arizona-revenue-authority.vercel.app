"use client";

import { useEffect, useState } from "react";
import {
  Bot,
  CheckCircle2,
  Circle,
  Film,
  Image as ImageIcon,
  Wind,
  FileText,
  Loader2,
  MessageSquare,
  Mic,
  Sparkles,
  Workflow,
  XCircle,
} from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { GitpageConceptCard } from "@/lib/gitpage/client";
import { PREMIUM_LIMITS } from "@/lib/website/premium";
import { TILE_OFF, TILE_ON } from "@/components/website/website-form-parts";
import {
  blankPremiumDetails,
  type HeroMotion,
  type WebsitePremiumDetails,
  type WebsiteProvisioning,
  type WebsiteQuality,
} from "@/types/website";

/**
 * Premium-only sections of the website builder (quality, capture/chat toggles,
 * concept cards, hero motion, details, build phase, hand-off summary). All plain
 * controlled components; the builder owns the config state.
 */

export function QualityPicker({
  value,
  onChange,
  disabled,
}: {
  value: WebsiteQuality;
  onChange: (next: WebsiteQuality) => void;
  disabled?: boolean;
}) {
  const options: Array<{ id: WebsiteQuality; label: string; hint: string; badge?: string }> = [
    {
      id: "premium",
      label: "Premium",
      badge: "Recommended",
      hint: "A studio-grade design system, copy written by the strongest model, generated photography, and your contact form + AI chat wired in. Builds take 10–20 minutes.",
    },
    {
      id: "standard",
      label: "Standard",
      hint: "The original quick build — template design, no form or chat wiring. Live in 1–3 minutes.",
    },
  ];
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {options.map((opt) => {
        const selected = value === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => onChange(opt.id)}
            disabled={disabled}
            aria-pressed={selected}
            className={
              (selected
                ? "border-primary bg-primary/5 ring-2 ring-primary/30"
                : "border-input bg-background hover:bg-muted/30") +
              " flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60"
            }
          >
            <p className="flex items-center gap-2 text-sm font-medium">
              {opt.id === "premium" && <Sparkles className="h-3.5 w-3.5 text-primary" />}
              {opt.label}
              {opt.badge && (
                <span className="rounded-full bg-primary/10 px-1.5 py-px text-[10px] font-medium text-primary">
                  {opt.badge}
                </span>
              )}
            </p>
            <p className="text-[11px] text-muted-foreground">{opt.hint}</p>
          </button>
        );
      })}
    </div>
  );
}

export function LeadCaptureToggles({
  includeForm,
  includeChat,
  includeVoice = true,
  voiceAvailable = false,
  onChange,
}: {
  includeForm: boolean;
  includeChat: boolean;
  includeVoice?: boolean;
  /** Workspace has a ready ElevenLabs connection; the voice tile only renders when true. */
  voiceAvailable?: boolean;
  onChange: (patch: {
    include_form?: boolean;
    include_chat?: boolean;
    include_voice?: boolean;
  }) => void;
}) {
  const voiceOn = includeChat && includeVoice;
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <label className={`${includeForm ? TILE_ON : TILE_OFF} flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors`}>
        <Checkbox
          checked={includeForm}
          onCheckedChange={(c) => onChange({ include_form: c === true })}
          className="mt-0.5"
        />
        <div>
          <p className="flex items-center gap-1.5 text-sm font-medium">
            <FileText className="h-3.5 w-3.5 text-violet-500 dark:text-violet-300" />
            Contact form feeds this workspace
          </p>
          <p className="text-xs text-muted-foreground">
            The site&apos;s contact form posts straight into Contacts (a
            &ldquo;Website contact&rdquo; form is created once and reused), and a
            speed-to-lead workflow is set up on it when the site publishes.
          </p>
        </div>
      </label>
      <label className={`${includeChat ? TILE_ON : TILE_OFF} flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors`}>
        <Checkbox
          checked={includeChat}
          onCheckedChange={(c) => onChange({ include_chat: c === true })}
          className="mt-0.5"
        />
        <div>
          <p className="flex items-center gap-1.5 text-sm font-medium">
            <MessageSquare className="h-3.5 w-3.5 text-violet-500 dark:text-violet-300" />
            AI chat widget on every page
          </p>
          <p className="text-xs text-muted-foreground">
            The workspace&apos;s Web Chat bubble is embedded, the live hostname
            is allow-listed, and the bot&apos;s knowledge base is seeded from
            the finished site so it can answer questions on day one.
          </p>
        </div>
      </label>
      {voiceAvailable && (
        <label
          className={`${voiceOn ? TILE_ON : TILE_OFF} flex items-start gap-3 rounded-xl border p-3 transition-colors sm:col-span-2 ${
            includeChat ? "cursor-pointer" : "cursor-not-allowed opacity-60"
          }`}
        >
          <Checkbox
            checked={voiceOn}
            disabled={!includeChat}
            onCheckedChange={(c) => onChange({ include_voice: c === true })}
            className="mt-0.5"
          />
          <div>
            <p className="flex items-center gap-1.5 text-sm font-medium">
              <Mic className="h-3.5 w-3.5 text-violet-500 dark:text-violet-300" />
              Visitors can talk to the chat (voice)
            </p>
            <p className="text-xs text-muted-foreground">
              Adds the mic button to the chat widget using this workspace&apos;s
              ElevenLabs connection. Voice is shared by every site in the
              workspace — unticking just leaves its current setting alone.
              {!includeChat ? " Needs the chat widget." : ""}
            </p>
          </div>
        </label>
      )}
    </div>
  );
}

export function ConceptPicker({
  subAccountId,
  niche,
  mode,
  value,
  onChange,
  disabled,
}: {
  subAccountId: string;
  niche: string | null;
  mode: "light" | "dark";
  value: string | null;
  onChange: (conceptId: string | null) => void;
  disabled?: boolean;
}) {
  const [cards, setCards] = useState<GitpageConceptCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setCards(null);
    setError(null);
    const qs = niche ? `?niche=${encodeURIComponent(niche)}` : "";
    fetch(`/api/sub-accounts/${subAccountId}/website/concepts${qs}`)
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as {
          concepts?: GitpageConceptCard[];
          error?: string;
        };
        if (!res.ok) throw new Error(body.error ?? "Could not load concepts.");
        if (!cancelled) setCards(body.concepts ?? []);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Could not load concepts.");
          setCards([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [subAccountId, niche]);

  // A concept from a different niche means nothing; clear it once the new list lacks it.
  useEffect(() => {
    if (cards && value && !cards.some((c) => c.id === value)) onChange(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards]);

  if (cards === null) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading design directions…
      </p>
    );
  }
  if (error) {
    return (
      <p className="text-xs text-muted-foreground">
        {error} — gitpage will pick the niche&apos;s default direction.
      </p>
    );
  }

  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      <button
        type="button"
        onClick={() => onChange(null)}
        disabled={disabled}
        aria-pressed={value === null}
        className={
          (value === null ? TILE_ON : TILE_OFF) +
          " flex flex-col items-start gap-1 rounded-xl border border-dashed p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60"
        }
      >
        <p className="text-sm font-medium">Let the studio choose</p>
        <p className="text-[11px] text-muted-foreground">
          gitpage picks the direction that fits this niche best. Rebuild to try another.
        </p>
      </button>
      {cards.map((c) => {
        const selected = value === c.id;
        const accent = c.accents[mode] ?? c.accents[c.defaultMode] ?? "#888";
        return (
          <button
            key={c.id}
            type="button"
            onClick={() => onChange(c.id)}
            disabled={disabled}
            aria-pressed={selected}
            className={
              (selected ? TILE_ON : TILE_OFF) +
              " flex flex-col items-start gap-1.5 rounded-xl border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60"
            }
          >
            <span className="flex items-center gap-2">
              <span
                aria-hidden
                className="inline-block h-4 w-4 rounded-full border border-black/10"
                style={{ backgroundColor: accent }}
              />
              <span className="text-sm font-medium">{c.name}</span>
            </span>
            <p className="text-[11px] leading-snug text-muted-foreground">{c.pitch}</p>
            {c.fit && (
              <p className="text-[10px] text-muted-foreground/80">
                <span className="font-medium">Fits:</span> {c.fit}
              </p>
            )}
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
              {c.archetype} · {c.typeSystem.replace(/_/g, " ")}
            </p>
          </button>
        );
      })}
    </div>
  );
}

/** Hero treatment as three option cards (a dropdown was easy to miss). */
export function HeroMotionSelect({
  value,
  onChange,
}: {
  value: HeroMotion | null;
  onChange: (next: HeroMotion | null) => void;
}) {
  const current: HeroMotion = value ?? "still";
  const options: Array<{ id: HeroMotion; label: string; hint: string; Icon: typeof Film }> = [
    { id: "still", label: "Photo", hint: "A generated hero photograph. Fastest and lightest.", Icon: ImageIcon },
    { id: "loop", label: "Video loop", hint: "A 5-second silent video made from the hero photo. Adds 2–4 min and about $0.40–1.00.", Icon: Film },
    { id: "atmosphere", label: "Animated background", hint: "Soft moving light and grain over the brand colours — no photo needed.", Icon: Wind },
  ];
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">Hero</p>
      <div className="grid gap-2 sm:grid-cols-3">
        {options.map((o) => {
          const selected = current === o.id;
          return (
            <button
              key={o.id}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange(o.id)}
              className={(selected ? TILE_ON : TILE_OFF) + " flex flex-col items-start gap-1.5 rounded-xl border p-3 text-left transition-colors"}
            >
              <span className={(selected ? "bg-violet-500 text-white" : "bg-violet-500/10 text-violet-500 dark:text-violet-300") + " flex h-7 w-7 items-center justify-center rounded-lg"}>
                <o.Icon className="h-4 w-4" />
              </span>
              <span className="text-sm font-medium">{o.label}</span>
              <span className="text-[11px] leading-snug text-muted-foreground">{o.hint}</span>
            </button>
          );
        })}
      </div>
      <p className="text-[11px] text-muted-foreground">Visitors who prefer reduced motion always see the still photo.</p>
    </div>
  );
}

type DetailKey = keyof WebsitePremiumDetails;

const DETAIL_FIELDS: Array<{
  key: DetailKey;
  label: string;
  hint: string;
  rows?: number;
  input?: boolean;
  placeholder?: string;
  /** Only shown for these niches (absent = all). */
  forNiches?: string[];
}> = [
  { key: "tagline", label: "Tagline", hint: `One line, ≤${PREMIUM_LIMITS.tagline} characters.`, input: true, placeholder: "Rituals that elevate your training." },
  { key: "founded_year", label: "Founded", hint: "Four-digit year.", input: true, placeholder: "2011" },
  { key: "brand_voice", label: "Brand voice", hint: `Up to ${PREMIUM_LIMITS.brandVoice} words, comma-separated — how the copy should sound.`, input: true, placeholder: "direct, athletic, warm" },
  { key: "metrics", label: "Numbers you can stand behind", hint: `One per line as "Label: Value" (≤${PREMIUM_LIMITS.metrics}). Only real figures — nothing is invented.`, rows: 4, placeholder: "Google rating: 4.9\nJobs completed: 40,000+" },
  { key: "team", label: "Team", hint: `One per line: "Name | Role | Credentials | What they do" (≤${PREMIUM_LIMITS.team}).`, rows: 4, placeholder: "Mia Carter | Head Coach | CSCS · USAW L2 | Barbell strength programming" },
  { key: "testimonials", label: "Testimonials", hint: `One per line: "Quote | Name | Role" (≤${PREMIUM_LIMITS.testimonials}). Real quotes only.`, rows: 4, placeholder: "They fixed it the same day and the price matched the quote. | Rachel N. | Homeowner" },
  { key: "offer_headline", label: "Offer headline", hint: `≤${PREMIUM_LIMITS.offerHeadline} characters.`, input: true, placeholder: "Start with your free week on us." },
  { key: "offer_bullets", label: "Offer bullets", hint: `One per line (≤${PREMIUM_LIMITS.offerBullets}).`, rows: 3 },
  { key: "offer_fine", label: "Offer fine print", hint: `≤${PREMIUM_LIMITS.offerFine} characters.`, input: true },
  { key: "gallery_notes", label: "Photography notes", hint: `Art direction for the generated images (≤${PREMIUM_LIMITS.galleryNotes} characters).`, rows: 3, placeholder: "Moody interiors, black steel, one yellow accent wall; a single athlete under side light." },
  { key: "social_links", label: "Social links", hint: `One per line: "Label | https://…" (≤${PREMIUM_LIMITS.socialLinks}).`, rows: 2, placeholder: "Instagram | https://instagram.com/yourbrand" },
  { key: "case_studies", label: "Case studies", hint: `One per line: "Client | Result | What you did" (≤${PREMIUM_LIMITS.caseStudies}). Real results only — they become the results strip when you haven't added numbers.`, rows: 4, placeholder: "Northgate Freight | 3 days → 2 hours reporting | Automated month-end reporting across the TMS and accounting", forNiches: ["ai_consulting", "ai_automation", "agency_consulting"] },
  { key: "tools", label: "Tools & platforms you work with", hint: `Comma-separated (≤${PREMIUM_LIMITS.tools}). Named on the site only if you list them here.`, input: true, placeholder: "n8n, Make, Zapier, OpenAI, Claude", forNiches: ["ai_consulting", "ai_automation"] },
  { key: "reference_notes", label: "Anything else", hint: `Notes for the copywriter — positioning, what to avoid, a reference site (≤${PREMIUM_LIMITS.referenceNotes} characters).`, rows: 3 },
];

export function PremiumDetailsFields({
  value,
  errors,
  onChange,
  niche = null,
}: {
  value: WebsitePremiumDetails | null;
  errors: Record<string, string>;
  onChange: (next: WebsitePremiumDetails) => void;
  niche?: string | null;
}) {
  const details = value ?? blankPremiumDetails();
  const set = (key: DetailKey, v: string) => onChange({ ...details, [key]: v });
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {DETAIL_FIELDS.filter((f) => !f.forNiches || (niche && f.forNiches.includes(niche))).map((f) => {
        const error = errors[`premium_details.${f.key}`];
        const wide = !f.input;
        return (
          <div key={f.key} className={wide ? "space-y-1.5 sm:col-span-2" : "space-y-1.5"}>
            <Label>{f.label}</Label>
            {f.input ? (
              <Input
                value={details[f.key] ?? ""}
                placeholder={f.placeholder}
                onChange={(e) => set(f.key, e.target.value)}
              />
            ) : (
              <Textarea
                rows={f.rows ?? 3}
                value={details[f.key] ?? ""}
                placeholder={f.placeholder}
                onChange={(e) => set(f.key, e.target.value)}
              />
            )}
            {error ? (
              <p className="text-[11px] text-destructive">{error}</p>
            ) : (
              <p className="text-[11px] text-muted-foreground">{f.hint}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

const PHASE_LABEL: Record<string, string> = {
  brief: "writing the brief",
  repo: "creating the repository",
  images_submit: "commissioning photography",
  images_wait: "generating photography",
  render: "designing the pages",
  shop: "adding the shop pages",
  deploy: "publishing",
  seo_finalize: "finalising the address for Google",
  check: "checking the template",
  copy: "copying the pages",
  finalize: "finalising the address",
  settle: "finishing up",
  completed: "done",
};

export function premiumPhaseLabel(phase: string | null | undefined): string | null {
  if (!phase) return null;
  return PHASE_LABEL[phase] ?? phase.replace(/_/g, " ");
}

export function ProvisioningSummary({
  provisioning,
  subAccountId,
}: {
  provisioning: WebsiteProvisioning;
  subAccountId: string;
}) {
  const rows: Array<{ ok: boolean | null; icon: React.ReactNode; text: React.ReactNode }> = [
    {
      ok: !!provisioning.formId,
      icon: <FileText className="h-3.5 w-3.5" />,
      text: provisioning.formId ? (
        <>
          Contact form wired —{" "}
          <a className="text-primary hover:underline" href={`/sa/${subAccountId}/forms/${provisioning.formId}`}>
            Website contact
          </a>
        </>
      ) : (
        "No contact form on this build."
      ),
    },
    {
      ok: provisioning.chatEnabled ? true : provisioning.chatAllowlisted ? null : false,
      icon: <Bot className="h-3.5 w-3.5" />,
      text: provisioning.chatEnabled ? (
        <>
          AI chat is live on {provisioning.hostname ?? "the site"}
          {provisioning.kbSeeded ? " with a knowledge base seeded from the site" : ""} —{" "}
          <a className="text-primary hover:underline" href={`/sa/${subAccountId}/ai-agents/web-chat`}>
            Web Chat settings
          </a>
        </>
      ) : provisioning.chatSkippedReason ? (
        `Chat widget on the site, bot not switched on: ${provisioning.chatSkippedReason}`
      ) : (
        "Chat not included."
      ),
    },
    {
      ok: provisioning.workflowStatus === "active" ? true : provisioning.workflowId ? null : false,
      icon: <Workflow className="h-3.5 w-3.5" />,
      text: provisioning.workflowId ? (
        <>
          Speed-to-lead workflow{" "}
          {provisioning.workflowStatus === "active" ? "published" : "saved as a draft (no SMS/email channel ready yet)"}
          {provisioning.workflowChannels.length ? ` — ${provisioning.workflowChannels.map(labelChannel).join(", ")}` : ""}{" "}
          —{" "}
          <a className="text-primary hover:underline" href={`/sa/${subAccountId}/workflows/${provisioning.workflowId}`}>
            open
          </a>
        </>
      ) : (
        "No speed-to-lead workflow (needs the contact form)."
      ),
    },
  ];
  return (
    <div className="border-t px-4 py-3">
      <p className="text-xs font-medium">Wired up on publish</p>
      <ul className="mt-1.5 space-y-1 text-xs">
        {rows.map((r, i) => (
          <li key={i} className="flex items-start gap-2 text-muted-foreground">
            <span className={r.ok === true ? "text-emerald-600" : r.ok === null ? "text-amber-600" : "text-muted-foreground/60"}>
              {r.ok === true ? <CheckCircle2 className="mt-px h-3.5 w-3.5" /> : r.ok === null ? <Circle className="mt-px h-3.5 w-3.5" /> : <XCircle className="mt-px h-3.5 w-3.5" />}
            </span>
            <span className="flex items-start gap-1.5">
              <span className="mt-px shrink-0 text-muted-foreground/70">{r.icon}</span>
              <span>{r.text}</span>
            </span>
          </li>
        ))}
        {provisioning.errors.length > 0 && (
          <li className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">
            Some steps need attention: {provisioning.errors.join(" · ")}
          </li>
        )}
      </ul>
    </div>
  );
}

function labelChannel(type: string): string {
  switch (type) {
    case "send_sms":
      return "instant SMS";
    case "send_email":
      return "instant email";
    case "notify":
      return "team alert";
    default:
      return type.replace(/_/g, " ");
  }
}
