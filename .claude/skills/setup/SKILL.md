---
name: setup
description: Guide the owner of this repo through setting up their CRM — prerequisites, branding, Firebase, and deployment — resuming wherever they left off. Use when they ask for help setting up the project, say "help me set up this project", type /setup, or seem new and haven't run the app yet.
---

# Set up this CRM

This skill walks the repo owner from a fresh clone to a running, deployed CRM.
It is a **convenience layer over [SETUP.md](../../../SETUP.md)**, not a
replacement: every step here has a documented manual equivalent, and the user
can do it by hand at any time.

Two ways through the longer phases:

- **CLI path** — Claude runs `firebase`, `gcloud` and `vercel` commands.
- **Console path** — Claude walks the user through the web consoles and they
  paste values back. **This is exactly today's documented process.**

Both paths end at the same `.env.local` and the same Firebase project, so
switching between them is free and needs no restart.

> **Entry point.** This skill assumes the repo is already cloned and open. The
> "generate my repo from the template" bootstrap happens *before* this skill
> exists — it lives in SETUP.md Phase 1 and the CLAUDE.md Onboarding Guide.

---

## Step 1 — Load or create the state file

Read `.leadstack-setup.json` at the repo root. It is gitignored, so it never
reaches the user's GitHub or any buyer.

If it does not exist, create it:

```json
{
  "version": 1,
  "startedAt": "<ISO timestamp>",
  "path": null,
  "phases": {
    "prereqs":     { "status": "pending" },
    "branding":    { "status": "pending" },
    "firebase":    { "status": "pending" },
    "secrets":     { "status": "pending" },
    "localVerify": { "status": "pending" },
    "deploy":      { "status": "pending" },
    "handoff":     { "status": "pending" }
  }
}
```

**Rules for this file — all of them matter:**

- `status` is one of `pending`, `in-progress`, `done`, `skipped`, `blocked`.
- `path` is `"cli"`, `"console"`, or `null` until the user chooses at Firebase.
- **Never write a secret, key, token, or password into this file.** It records
  progress only. Every value belongs in `.env.local`, which is where SETUP.md
  promises users will find it.
- On `blocked`, add a short `reason` string so a later session can explain the
  hold-up without re-deriving it.
- On `done`, add `at` with the timestamp.
- Write the file after every phase transition, not just at the end — the whole
  point is surviving a session that stops abruptly.

## Step 2 — Route to the right phase

1. Find the **first phase not `done` or `skipped`**, in the order listed above.
2. If that is not `prereqs`, this is a resume. Say so in one line naming what
   is already finished and what is next, then continue — do not restart
   completed work and do not re-ask questions already answered.
3. If a phase is `blocked`, surface its `reason` first and offer to retry it or
   move past it.
4. Run the phase (see the phase sections below).
5. On completion, update the state file and continue to the next phase.

Ask before moving between phases only where the phase itself says to. Do not
narrate the state machine to the user — they want their CRM set up, not a tour
of the bookkeeping.

## Step 3 — Honour path switching at any moment

If the user says anything meaning *"do it the manual way"* or *"just use
commands"* — in whatever words — switch immediately:

1. Update `path` in the state file.
2. Continue from the **current sub-step**. Never restart the phase.
3. Confirm in one short line. Do not re-explain the trade-off they just chose.

Because both paths converge on the same `.env.local` and the same Firebase
project, there is nothing to undo. If the user seems to fear being locked in,
say so plainly.

## Step 4 — Fall back rather than dead-end

Every automated step has a documented manual equivalent in SETUP.md. When a
command fails:

1. Say what failed, in one plain sentence. No stack traces at the user.
2. Fall back to the manual instructions **for that one value**, and ask them to
   paste it.
3. Continue the run. A single failed command is not a failed setup.

Never retry the same failing command more than twice. Never leave the user at a
raw error with no next action.

---

## Phases

Read the reference file for the phase you are running. Read **only that one** —
they are written to be used independently, and loading all of them at once
wastes context the user is paying for.

| Phase | Covers | Read |
|---|---|---|
| `prereqs` | tools, installs, `pnpm install` | [references/prereqs.md](references/prereqs.md) |
| `branding` | `CUSTOM_BRAND` in `src/config/landing.ts` | [references/branding.md](references/branding.md) |
| `firebase` | project, config, Firestore, admin key, rules — **the path fork** | [references/firebase.md](references/firebase.md) |
| `secrets` | generated secrets, app URL, bootstrap admin | [references/local.md](references/local.md) |
| `localVerify` | `pnpm doctor`, `pnpm dev`, smoke test | [references/local.md](references/local.md) |
| `deploy` | `vercel link`, env push, deploy, form preflight | [references/deploy.md](references/deploy.md) |
| `handoff` | hand off to Guided setup (`/agency/setup`) | [references/handoff.md](references/handoff.md) |

If a reference file is missing for some reason, fall back to the matching
section of SETUP.md rather than improvising — it is the source of truth for
every one of these phases.

## Env var rule (applies to every phase)

`src/lib/setup/env-schema.mjs` is the single source of truth for which
environment variables exist, how they group, and what a valid value looks
like. It also feeds `pnpm doctor` and the in-app setup form.

**Read that catalog. Never hardcode a list of variable names.** A variable
that is not in it is not one this app reads.

## When to run this

- The user asks for help setting up the project, or types `/setup`.
- The user returns to a half-finished setup and wants to continue.
- The user wants to switch between the CLI and console approaches.
