# Phase: branding

Covers SETUP.md Phase 2 — white-labelling the landing page. Identical on both
paths. Do this **before** Firebase: it is quick, it is visible, and it lets the
user see their own brand the moment the app first boots.

## Step 1 — Confirm the landing variant

Check `LANDING_VARIANT` in `src/config/landing.ts`. It must be `"custom"` so
`/` renders the white-label landing rather than the template's own marketing
page. If it says anything else, set it to `"custom"` and say why in one line.

## Step 2 — Ask for the five fields that actually render

Ask for all five in **one message**, not five separate questions. A user three
minutes into setup should not be interrogated field by field.

| Field | What it is | Appears in |
|---|---|---|
| `name` | Business name | navbar, hero, footer, page title |
| `tagline` | One-line positioning | hero subtitle, `<meta description>` |
| `shortDescription` | ~140 chars, reads like a tweet | under the hero headline |
| `supportEmail` | Contact address | CTA buttons, FAQ, footer |
| `primaryDomain` | No `https://`, no trailing slash | footer, `og:url`, canonical |

Write them into `CUSTOM_BRAND` in `src/config/landing.ts`.

If the user would rather brand it later, that is fine — the page renders
cleanly with the placeholders so they can still verify the app boots. Mark the
phase `skipped` and flag it as a TODO before the deploy phase, where their real
domain and brand start mattering publicly.

## Step 3 — Do NOT interview for pricing tiers

`CUSTOM_BRAND.pricing` exists in the config, but **the pricing section is not
rendered** on the custom landing. The variant is wired for a done-for-you sales
motion: prospects see a "Talk to us" CTA, the owner takes payment off-system,
provisions a sub-account, and invites the client through the in-app invite flow.

Asking a new user to invent three tiers × seven fields for something their
visitors will never see is roughly twenty wasted questions at the exact moment
momentum matters most. Don't.

Mention it in one line instead — *"pricing tiers are off by default since the
landing is set up for done-for-you sales; the config's there when you want
self-serve"* — and move on. If they ask to enable it, point them at the
re-enable checklist in the comment above `pricing:` in `src/config/landing.ts`.
That checklist involves rendering `<CustomPricing />`, restoring the nav link,
wiring Stripe checkout, and building a public signup flow — it is a project,
not a setup step, and it needs the Stripe phase finished first.

## Done when

`LANDING_VARIANT` is `"custom"` and the five fields are written (or the phase
is explicitly `skipped`). Mark `branding` `done` and continue to `firebase`.
