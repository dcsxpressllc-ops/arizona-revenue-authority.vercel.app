# Phase: handoff

The last phase. Everything the CRM needs to **run** is done; what remains are
optional integrations, and none of them need this terminal.

## Step 1 — Understand what is actually left

Per `src/lib/setup/env-schema.mjs`, every remaining variable is `feature` tier,
and the catalog's own words are that *"off" is a fine steady state*. Nothing
below is required. Each degrades cleanly:

| Feature | Without it |
|---|---|
| Stripe | no checkout; rest of the CRM unaffected |
| Resend | send-email route returns 503 with a clean error |
| Twilio | send-SMS route returns 503 with a clean error |
| QStash | automations don't fire; website builds stay queued |
| gitpage | website builder unavailable |

Do not present these as a to-do list the user is behind on. They have a
working, deployed CRM. This is a menu, not a backlog.

## Step 2 — Hand off to the in-app form

Say it in one short message, not a wall of text:

> Your CRM is live at `<domain>`. Sign up with `<BOOTSTRAP_ADMIN_EMAIL>` to
> claim the agency owner account, then go to **Agency → Get started → Open Guided
> setup** (or `/agency/setup`) and switch the toggle on. Add your Stripe, Resend, Twilio, QStash and gitpage
> keys there whenever you're ready — each save writes to Vercel and redeploys
> for you. You don't need this terminal again. Switch the toggle back off when
> you're done.

The form shows a three-state status board per key — `○ Not set`,
`⏳ Saved · redeploy`, `✓ Active` — and validates values with the same shape
checks as `pnpm doctor`, so the user gets the same feedback quality they got
here.

## Step 3 — Offer the terminal alternative

Some people would rather stay where they are. Offer once:

> Or if you'd rather do it here, tell me which service you want to set up and
> I'll walk you through it and push the keys for you.

If they choose this, follow SETUP.md Phase 4 (Stripe, Resend, Twilio) and
Phase 5 (QStash, gitpage, local tunnel) and push each value with
`vercel env add`. Do not mark the phase `done` until they say they are
finished, so a resumed session lands back here rather than at the start.

## Step 4 — Close out

Three things the user should leave with, briefly:

1. **Where their config lives** — `.env.local` locally, Vercel environment
   variables in production. One place each, nothing hidden elsewhere.
2. **`pnpm doctor`** — run it any time to see what is set, what is missing,
   and what looks malformed.
3. **SETUP.md Phase 6** — the full 24-item verification checklist, for when
   they want to exercise every feature properly.

Then stop. Do not offer further work, do not suggest improvements to their
setup, and do not re-list the optional services. They just finished something
long; let it be finished.

## Done when

The user has been handed off — either to the in-app form or through the
remaining services in the terminal. Mark `handoff` `done`. Setup is complete.
