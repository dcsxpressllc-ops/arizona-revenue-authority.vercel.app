# Phase: deploy

Covers SETUP.md Phase 6 — going live, and enabling the in-app setup form so
the user never needs this terminal again.

## Step 1 — Link the project

```bash
vercel login      # one-time browser click-through
vercel link
```

`vercel link` writes `.vercel/project.json`. Read it — it hands you two of the
four preflight values for free:

| Field in the file | Env variable |
|---|---|
| `projectId` | `VERCEL_PROJECT_ID` |
| `orgId`, **only if it starts `team_`** | `VERCEL_TEAM_ID` |

A personal (non-team) account has an `orgId` that is not a `team_` id — leave
`VERCEL_TEAM_ID` unset in that case. It is optional by design.

## Step 2 — Create the deploy hook

```bash
vercel deploy-hooks create leadstack-setup --ref main
```

The command returns the hook URL → `VERCEL_DEPLOY_HOOK_URL`.

**If this fails**, the likely cause is that the project is not yet connected to
a Git repository — deploy hooks trigger a branch build, so they need one. Try
`vercel git connect`, then retry. If it still fails, fall back: the user
creates it at Project → Settings → Git → Deploy Hooks and pastes the URL.

## Step 3 — The one dashboard visit

`VERCEL_TOKEN` cannot be minted from the CLI. Send the user to **Account
Settings → Tokens**, have them create one, and take the paste.

This is the **only** Vercel dashboard visit in the entire setup. Worth saying so —
it reads as a short detour rather than the start of another console slog.

## Step 4 — Push the environment and deploy

Loop `vercel env add` over every variable that is set locally, driven by
`src/lib/setup/env-schema.mjs` — the `boot` tier plus the four `preflight`
values. **Read the catalog; never hardcode a list of variable names.** When a
feature is added to the app later, that file is the one place it appears.

```bash
vercel deploy --prod
```

Then set `NEXT_PUBLIC_APP_URL` to the real Vercel domain (both in `.env.local`
and in Vercel) and **deploy once more**. Two reasons, both non-obvious:

- QStash and the website builder read it to construct their callback URLs.
- The build must be able to read the `VERCEL_*` preflight values before
  `vercelConfigured()` will un-gray the in-app setup form.

For `FIREBASE_ADMIN_PRIVATE_KEY`, paste the full key including the
`-----BEGIN PRIVATE KEY-----` / `-----END PRIVATE KEY-----` markers, without
the surrounding double quotes used in `.env.local`. Vercel handles the
newlines itself.

## Step 5 — Security close-out (required, not optional)

Say this out loud before finishing. Do not bury it, do not skip it because the
setup "worked":

> `VERCEL_TOKEN` can read and write every environment variable on your account
> and trigger deployments. It is now stored in your project so the in-app setup
> form can use it. When you've finished adding your API keys, turn the form's
> toggle back off. If the form was ever reachable publicly, rotate the token.

Record in the state file whether the user confirmed they understood — not the
token, obviously. A later session should be able to remind them.

The form is owner-gated and its preflight keys are deliberately not writable
through itself, so there is no privilege-escalation loop. But a live form plus
a broad token is still a real exposure if it is left on and forgotten.

## Step 6 — Production follow-ups

Mention these once, as a short list. They are not this phase's job, but the
user should know they exist before their first real customer:

- **Stripe** — add a production webhook endpoint at
  `https://<domain>/api/webhooks/stripe` (events `checkout.session.completed`,
  `checkout.session.async_payment_succeeded`, `customer.subscription.updated`,
  `customer.subscription.deleted`) and update `STRIPE_WEBHOOK_SECRET`
  with the new signing secret. The local `stripe listen` secret is not valid
  in production.
- **Twilio** — repoint the number's inbound webhook off any local tunnel to
  `https://<domain>/api/webhooks/twilio/inbound`, or inbound STOP messages
  never reach the app and automations keep texting opted-out contacts.
- **Resend** — the sending domain must be fully verified; `onboarding@resend.dev`
  is test-only.

## Done when

The app is live on its Vercel domain, `boot` + `preflight` values are pushed,
the redeploy has run, and the close-out was said. Mark `deploy` `done` and
continue to `handoff`.
