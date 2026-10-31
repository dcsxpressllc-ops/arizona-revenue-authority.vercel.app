# Phase: firebase

Covers SETUP.md Phase 3. **This is where the two paths diverge** — and the
only phase where the choice matters.

Produces nine of the thirteen `boot` env vars: six `NEXT_PUBLIC_FIREBASE_*`
and three `FIREBASE_ADMIN_*`.

## Step 1 — Offer the choice, once

The user has now watched prerequisites install and their brand go onto the
landing page. They have context. Ask here, not earlier:

> Firebase is the longest part of setup. I can do most of it with commands in
> about two minutes, or walk you through the console the classic way — about
> fifteen. Either way you end up in exactly the same place, and you can switch
> at any point just by telling me.

Record the answer as `path` in the state file. Then follow **Step 2 (CLI)** or
**Step 3 (console)**.

If they have no preference, recommend the CLI path — but never re-ask, and
never re-explain the trade-off after they have chosen.

---

## Step 2 — CLI path

Sign in first. Both are one-time browser click-throughs:

```bash
firebase login
gcloud auth login
```

### 2a. Create the project

```bash
firebase projects:create <project-id>
```

Ask the user for a project ID (lowercase, hyphens, globally unique — suggest
one based on their business name). **Common failures, each with a specific
response:**

- *Project quota exceeded* — Google caps projects per account. Fall back:
  they create it at console.firebase.google.com and give you the project ID.
- *Terms of Service not accepted* — they must visit the console once and
  accept. Send them there, wait, retry.
- *Billing required* — rare for project creation. If it appears, fall back to
  console creation.

**The user may already have a project.** If so, skip creation entirely and
adopt theirs: `firebase use <project-id>`. Nothing about the CLI path requires
a project it created.

### 2b. Register a web app and read the config

```bash
firebase apps:create web <nickname> --project <project-id>
firebase apps:sdkconfig web <appId> --project <project-id>
```

The second command prints the entire `firebaseConfig` object. Map it into
`.env.local`:

| Config key | Env variable |
|---|---|
| `apiKey` | `NEXT_PUBLIC_FIREBASE_API_KEY` |
| `authDomain` | `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` |
| `projectId` | `NEXT_PUBLIC_FIREBASE_PROJECT_ID` |
| `storageBucket` | `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` |
| `messagingSenderId` | `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` |
| `appId` | `NEXT_PUBLIC_FIREBASE_APP_ID` |

No console visit, no paste. This is the single biggest time saving in setup.

### 2c. Create the Firestore database

Region is a judgement call — **ask the user**, don't guess. Suggest the one
closest to their customers and note it cannot be changed later.

```bash
gcloud firestore databases create --location=<region> --project=<project-id>
```

### 2d. Create the service-account key

```bash
gcloud iam service-accounts keys create <tmp-path>.json \
  --iam-account=firebase-adminsdk-<suffix>@<project-id>.iam.gserviceaccount.com \
  --project=<project-id>
```

Find the exact account address first with:

```bash
gcloud iam service-accounts list --project=<project-id>
```

Read the JSON **from disk** and extract three values:

| JSON key | Env variable |
|---|---|
| `project_id` | `FIREBASE_ADMIN_PROJECT_ID` |
| `client_email` | `FIREBASE_ADMIN_CLIENT_EMAIL` |
| `private_key` | `FIREBASE_ADMIN_PRIVATE_KEY` |

**Then delete the JSON file.** It is a full credential.

`FIREBASE_ADMIN_PRIVATE_KEY` must be written wrapped in double quotes with
literal `\n` escapes preserved — `pnpm doctor` checks for the BEGIN/END markers
and for the line breaks, and fails the setup if either is mangled.

**Never echo the private key into the conversation.** Read it, write it to
`.env.local`, move on.

---

## Step 3 — Console path

This is today's documented process, unchanged. Follow SETUP.md Phase 3 and
walk the user through it:

1. **Create a project** at console.firebase.google.com. Analytics can be
   disabled — it is not used.
2. **Register a web app** — Project Settings → Your apps → web icon (`</>`) →
   nickname → Register. Skip Firebase Hosting.
3. They paste the whole `firebaseConfig` object to you; you map the six values
   using the table in Step 2b.
4. **Service account** — Project Settings → Service accounts → Generate new
   private key. They open the downloaded JSON and paste its contents; you
   extract the three values, then **tell them to delete the file**.
5. **Firestore** — Firestore Database → Create database → **production mode**
   (the repo ships strict owner-scoped rules; test mode is wrong here) →
   closest location → Enable.

Take the pastes one at a time. Confirm each value landed before asking for the
next — a user pasting four things at once loses track of which failed.

---

## Step 4 — Enable Email/Password (both paths)

**This step is manual on purpose.** There is a REST path, but it only works by
upgrading the project to Identity Platform, which changes the free tier from
50,000 monthly active users to 3,000 daily active users on the no-cost Spark
plan. That is a billing decision, and it is not ours to make silently on
someone else's project.

Four clicks, once:

> Firebase Console → **Authentication** → **Get started** →
> **Email/Password** → toggle on → **Save**

Wait for confirmation before continuing. Nothing in the app works without it —
the first signup is how the agency owner account gets created.

## Step 5 — Deploy rules and indexes (both paths)

A fresh clone has no `.firebaserc`, so point the CLI at the project first
(skip if `firebase use` already shows it):

```bash
firebase use <project-id>
firebase deploy --only firestore:rules,firestore:indexes
```

**Always both flags in one command.** Running `--only firestore:rules` alone
silently skips the indexes, and the failure surfaces much later as an opaque
`FAILED_PRECONDITION: The query requires an index` — the public booking page's
availability check is the usual first victim.

Indexes take a few minutes to build after the deploy returns. Say so, so a
later "why is this failing" has an obvious cause.

## Done when

Nine env vars are written, Email/Password is enabled, and rules + indexes are
deployed. Mark `firebase` `done` and continue to `secrets`.
