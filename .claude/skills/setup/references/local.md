# Phases: secrets + localVerify

Covers the generated half of SETUP.md Phase 2 and the local part of Phase 6.
Identical on both paths.

---

## Phase: secrets

### Step 1 — Ensure `.env.local` exists

Copy `.env.example` to `.env.local` if it is not already there. Every value in
setup lands in this one file — SETUP.md promises users nothing is hidden
elsewhere, so keep that true.

`.gitignore` covers all `.env*` files except `.env.example`, so these values
never reach GitHub.

### Step 2 — Generate three secrets

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Run it **three times** and write:

| Env variable | Purpose |
|---|---|
| `COOKIE_SECRET_CURRENT` | active session-cookie key |
| `COOKIE_SECRET_PREVIOUS` | rotation slot |
| `AUTOMATIONS_TOKEN_SECRET` | HMAC key signing unsubscribe, invite, checkout and booking links |

**The two cookie secrets must differ.** One is the rotation slot; `pnpm doctor`
warns if they are identical. Generate separately — do not reuse one value.

Note for the user, once: rotating `AUTOMATIONS_TOKEN_SECRET` later invalidates
every signed link already sent (unsubscribe, invites, checkout and booking links). That is by
design, but it surprises people.

### Step 3 — Ask for the two App values

| Env variable | Value |
|---|---|
| `NEXT_PUBLIC_APP_URL` | `http://localhost:3000` for now — the deploy phase changes it |
| `BOOTSTRAP_ADMIN_EMAIL` | the email **they** will sign up with first |

Explain `BOOTSTRAP_ADMIN_EMAIL` properly, because it is the one value people
get wrong and cannot easily undo: the first signup matching it is promoted to
agency owner and mints the agency plus a default "Main" sub-account. Every
later signup needs a typed invite, so a stranger cannot claim the owner slot
during the deploy window. Once an owner exists the variable is ignored.

No trailing slash on `NEXT_PUBLIC_APP_URL` — it breaks OAuth redirect-URI
matching, and `pnpm doctor` warns about it.

---

## Phase: localVerify

### Step 4 — Run the preflight

```bash
pnpm doctor
```

All `boot`-tier groups must be clean: Firebase client (6), Firebase Admin (3),
Session cookies (2), App (2). Feature-tier warnings are expected and fine at
this stage — say so, or the user will think something is broken.

Two `boot` failures are common and worth recognising on sight:

- **Private key malformed / no line breaks** — the `\n` escapes were lost.
  Rewrite the value from the source rather than hand-patching it.
- **Client project ≠ admin project** — the web app config and the service
  account came from different Firebase projects. They must match.

Do not continue past a failing `boot` group. Everything downstream will fail
in a more confusing way.

### Step 5 — Start it and look at it

```bash
pnpm dev
```

Then a **short** smoke test — not the full 24-item list in SETUP.md, which
belongs to a user who wants exhaustive verification later:

1. `/` shows **their** brand, not the template's.
2. Sign up at `/signup` with `BOOTSTRAP_ADMIN_EMAIL` → lands on `/agency`,
   with an agency and a "Main" sub-account card created (the **Get started**
   page at `/agency/get-started` lists next steps).
3. Add one contact. It saves and appears in the list.

That covers the landing config, Firebase Auth, Firestore writes, the admin
SDK, and the tenancy bootstrap — everything this phase set up.

If step 1 still shows the template's branding, `LANDING_VARIANT` is not
`"custom"` or `CUSTOM_BRAND` was never filled in — go back to the branding
phase rather than debugging forward.

Point them at SETUP.md Phase 6 for the full checklist when they want it.

## Done when

`pnpm doctor` is clean on `boot`, the app runs, and the three smoke steps pass.
Mark both phases `done` and continue to `deploy`.
