# Phase: prereqs

Covers SETUP.md Phase 1 (tools) and the first half of Phase 2 (dependencies).
Identical on both the CLI and console paths — do not ask about paths here.

## Step 1 — Check what's installed

Run these and report what is present vs missing in one short table. Do not
install anything before showing the user what you found.

| Tool | Check | Needed for |
|---|---|---|
| git | `git --version` | 2.30+ |
| Node | `node --version` | **22.13+** (install the current LTS; Node 20 can't run the pnpm version this repo pins) |
| pnpm | `pnpm --version` | package manager |
| Firebase CLI | `firebase --version` | Firebase project + rules deploy |
| gcloud | `gcloud --version` | service-account key, Firestore create |
| Vercel CLI | `vercel --version` | deployment |

Optional, only if the user wants local automation testing later — mention
once, do not block on them:

- `stripe --version` (local webhook forwarding)
- `cloudflared --version` or `ngrok --version` (public tunnel)

## Step 2 — Install what's missing

| Tool | Windows | macOS |
|---|---|---|
| git | `winget install Git.Git` | `brew install git` |
| Node | `winget install OpenJS.NodeJS.LTS` | `brew install node` |
| pnpm | `npm install -g pnpm` | `npm install -g pnpm` |
| Firebase CLI | `npm install -g firebase-tools` | same |
| Vercel CLI | `npm install -g vercel` | same |
| gcloud | `winget install Google.CloudSDK` | `brew install --cask google-cloud-sdk` |

**Set expectations on gcloud before running it.** Its installer is much larger
than the others and takes several minutes. Say so first — a non-technical user
watching an apparently-frozen terminal is exactly the moment setup gets
abandoned. Something like: *"This one's a big download — a few minutes. It's
the last install."*

**After installing anything, the terminal must be reopened** so PATH updates.
Tell the user plainly, wait for them to do it, then re-run the version checks
before continuing. Do not assume the install worked.

## Step 3 — Install project dependencies

```bash
pnpm install
```

Confirm `node_modules` exists afterwards. If install fails, the usual causes
are a Node version below 22.13 or a corporate proxy — check `node --version`
first before anything more exotic.

## Done when

All six required tools report a version, `pnpm install` completed, and
`node_modules` exists. Mark `prereqs` as `done` and continue to `branding`.

If the user declines a required install, mark `blocked` with the tool name as
the reason and explain what will not work — do not silently continue as though
it were fine.
