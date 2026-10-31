// Env catalog: which variables exist, how they group into features, and what a
// valid value looks like. Plain ESM with no dependencies and no process.env or
// fs access, because scripts/doctor.mjs runs it under bare node and the setup
// form imports it via `@/`. Consumers pass in their own value getter (the form
// merges process.env with Vercel's stored key list).


/** Obvious placeholders count as unset. */
export const PLACEHOLDER = /^(your|changeme|xxx+|<|paste|todo|example)/i;

/** Present, non-blank and not a placeholder. */
export function isPresent(value) {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    !PLACEHOLDER.test(value.trim())
  );
}

// Shape validators: return a warning string or null.

export const startsWith = (p) => (v) =>
  v.startsWith(p)
    ? null
    : `expected to start with "${p}" — double-check the paste`;
export const isUrl = (v) =>
  /^https?:\/\//.test(v) ? null : "should be a full http(s):// URL";
export const isEmail = (v) =>
  /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)
    ? null
    : "doesn't look like an email address";
export const isE164 = (v) =>
  /^\+[1-9]\d{6,14}$/.test(v)
    ? null
    : "should be E.164 format, e.g. +15551234567";
export const isNumeric = (v) =>
  /^\d+$/.test(v) ? null : "expected to be all digits";

// Groups.
//
// tier: "boot" = needed to start; "feature" = optional integration, "off" is
// a fine steady state;
// "preflight" = needed by the setup form itself, never writable through it.
// var level: "req" counts toward configured/partial, "rec" recommended, "opt"
// optional or defaulted.
// `deep(add, env)` does cross-field checks via env.has()/env.val().

export const GROUPS = [
  // Preflight: needed before the setup form can be enabled
  {
    title: "Vercel (setup form prerequisite)",
    tier: "preflight",
    off: "the in-app setup form stays disabled — set these manually to enable it",
    vars: [
      ["VERCEL_TOKEN", "req"],
      ["VERCEL_PROJECT_ID", "req", startsWith("prj_")],
      ["VERCEL_DEPLOY_HOOK_URL", "req", isUrl],
      ["VERCEL_TEAM_ID", "opt", startsWith("team_")],
    ],
  },

  // Required to run
  {
    title: "Firebase — client SDK",
    tier: "boot",
    vars: [
      ["NEXT_PUBLIC_FIREBASE_API_KEY", "req"],
      ["NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN", "req"],
      ["NEXT_PUBLIC_FIREBASE_PROJECT_ID", "req"],
      ["NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET", "req"],
      ["NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID", "req"],
      ["NEXT_PUBLIC_FIREBASE_APP_ID", "req"],
    ],
    deep(add, env) {
      const pid = env.val("NEXT_PUBLIC_FIREBASE_PROJECT_ID");
      if (pid && env.has("NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN")) {
        const d = env.val("NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN");
        if (d !== `${pid}.firebaseapp.com`)
          add("warn", `AUTH_DOMAIN "${d}" isn't the usual ${pid}.firebaseapp.com`);
      }
      if (pid && env.has("NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET")) {
        const b = env.val("NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET");
        if (b !== `${pid}.appspot.com` && b !== `${pid}.firebasestorage.app`)
          add("warn", `STORAGE_BUCKET "${b}" doesn't match this project's usual bucket`);
      }
    },
  },
  {
    title: "Firebase — Admin SDK",
    tier: "boot",
    vars: [
      ["FIREBASE_ADMIN_PROJECT_ID", "req"],
      ["FIREBASE_ADMIN_CLIENT_EMAIL", "req", (v) =>
        v.includes("@") && v.includes("gserviceaccount.com")
          ? null
          : "expected a @<project>.iam.gserviceaccount.com address"],
      ["FIREBASE_ADMIN_PRIVATE_KEY", "req"],
    ],
    deep(add, env) {
      if (env.has("FIREBASE_ADMIN_PRIVATE_KEY")) {
        const key = env.val("FIREBASE_ADMIN_PRIVATE_KEY").replace(/\\n/g, "\n");
        const ok =
          key.includes("-----BEGIN PRIVATE KEY-----") &&
          key.includes("-----END PRIVATE KEY-----");
        if (!ok)
          add("error", "PRIVATE_KEY malformed — no BEGIN/END markers (copy the whole key incl. markers)");
        else if (!key.includes("\n"))
          add("error", 'PRIVATE_KEY has no line breaks — keep the literal \\n escapes from the JSON');
      }
      if (env.has("NEXT_PUBLIC_FIREBASE_PROJECT_ID") && env.has("FIREBASE_ADMIN_PROJECT_ID")) {
        const cp = env.val("NEXT_PUBLIC_FIREBASE_PROJECT_ID");
        const ap = env.val("FIREBASE_ADMIN_PROJECT_ID");
        if (cp !== ap)
          add("error", `client project "${cp}" ≠ admin project "${ap}" — must be the SAME project`);
      }
    },
  },
  {
    title: "Session cookies",
    tier: "boot",
    vars: [
      ["COOKIE_SECRET_CURRENT", "req"],
      ["COOKIE_SECRET_PREVIOUS", "req"],
    ],
    deep(add, env) {
      if (env.has("COOKIE_SECRET_CURRENT") && env.has("COOKIE_SECRET_PREVIOUS")) {
        if (env.val("COOKIE_SECRET_CURRENT") === env.val("COOKIE_SECRET_PREVIOUS"))
          add("warn", "the two cookie secrets are identical — they should differ (one is the rotation slot)");
        if (env.val("COOKIE_SECRET_CURRENT").length < 32)
          add("warn", "cookie secret looks short — generate with: openssl rand -base64 32");
      }
    },
  },
  {
    title: "App",
    tier: "boot",
    vars: [
      ["NEXT_PUBLIC_APP_URL", "req", isUrl],
      ["BOOTSTRAP_ADMIN_EMAIL", "rec", isEmail],
    ],
    deep(add, env) {
      if (env.has("NEXT_PUBLIC_APP_URL") && env.val("NEXT_PUBLIC_APP_URL").endsWith("/"))
        add("warn", "APP_URL has a trailing slash — drop it (it breaks OAuth redirect-URI matching)");
    },
  },

  // Features
  {
    title: "Billing (Stripe)",
    tier: "feature",
    off: "checkout + subscription billing disabled",
    vars: [
      ["NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", "req", startsWith("pk_")],
      ["STRIPE_SECRET_KEY", "req", startsWith("sk_")],
      ["STRIPE_WEBHOOK_SECRET", "req", startsWith("whsec_")],
      ["STRIPE_PRO_PRICE_ID", "req", startsWith("price_")],
    ],
    deep(add, env) {
      if (env.has("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY") && env.has("STRIPE_SECRET_KEY")) {
        const pubLive = env.val("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY").startsWith("pk_live");
        const secLive = env.val("STRIPE_SECRET_KEY").startsWith("sk_live");
        if (pubLive !== secLive)
          add("warn", "publishable + secret keys mix test/live modes — they must match");
      }
    },
  },
  {
    title: "Email (Resend)",
    tier: "feature",
    off: "outbound email + email automations disabled",
    vars: [
      ["RESEND_API_KEY", "req", startsWith("re_")],
      ["EMAIL_FROM", "req", (v) =>
        v.includes("@") ? null : "should contain a sender email, e.g. Brand <hi@yourdomain.com>"],
      // Signing secret for Resend's email.received webhook. Without it the inbox
      // toggle won't enable and replies keep going to Reply-To.
      ["RESEND_WEBHOOK_SECRET", "opt", startsWith("whsec_")],
    ],
    deep(add, env) {
      if (env.has("EMAIL_FROM") && env.val("EMAIL_FROM").includes("resend.dev"))
        add("warn", "EMAIL_FROM uses the resend.dev sandbox — fine for testing, untrusted in production");
    },
  },
  {
    title: "SMS (Twilio)",
    tier: "feature",
    off: "SMS send + STOP/START opt-out disabled",
    vars: [
      ["TWILIO_ACCOUNT_SID", "req", startsWith("AC")],
      ["TWILIO_AUTH_TOKEN", "req"],
      ["TWILIO_FROM_NUMBER", "req", isE164],
    ],
  },
  {
    title: "Automations + secure links (QStash)",
    tier: "feature",
    off: "scheduled automation steps, website polling, booking reminders disabled",
    vars: [
      ["QSTASH_URL", "req", isUrl],
      ["QSTASH_TOKEN", "req"],
      ["QSTASH_CURRENT_SIGNING_KEY", "req"],
      ["QSTASH_NEXT_SIGNING_KEY", "req"],
      ["AUTOMATIONS_TOKEN_SECRET", "req"],
    ],
  },
  {
    title: "AI replies (OpenRouter)",
    tier: "feature",
    off: "AI Agents stay silent on every channel",
    vars: [["OPENROUTER_API_KEY", "req", startsWith("sk-or-")]],
  },
  {
    title: "AI website KB (Firecrawl)",
    tier: "feature",
    off: "the agent's 'Refresh KB' button is disabled (bot still replies)",
    vars: [["FIRECRAWL_API_KEY", "req", startsWith("fc-")]],
  },
  {
    title: "AI Voice (Vapi)",
    tier: "feature",
    off: "inbound + outbound voice agent disabled",
    vars: [
      ["VAPI_API_KEY", "req"],
      ["VAPI_WEBHOOK_SECRET", "req"],
    ],
  },
  {
    title: "Google Calendar sync",
    tier: "feature",
    off: "two-way calendar sync disabled (booking pages use internal events + the read-only .ics feed only)",
    vars: [
      ["GOOGLE_OAUTH_CLIENT_ID", "req"],
      ["GOOGLE_OAUTH_CLIENT_SECRET", "req"],
    ],
  },
  {
    title: "Facebook + Instagram (Meta)",
    tier: "feature",
    off: "FB/IG inbox + Social Planner disabled",
    vars: [
      ["META_APP_ID", "req", isNumeric],
      ["META_APP_SECRET", "req"],
      ["META_WEBHOOK_VERIFY_TOKEN", "rec"],
    ],
  },
  {
    title: "Website builder (gitpage)",
    tier: "feature",
    off: "the Website builder Build button is disabled",
    vars: [
      ["GITPAGE_API_KEY", "req", startsWith("gp_")],
      ["GITPAGE_API_URL", "opt", isUrl],
      ["PAGESPEED_API_KEY", "opt"],
    ],
  },
  {
    title: "Leads map (Mapbox)",
    tier: "feature",
    off: "dashboard shows a 'Mapbox not configured' card (data still captured)",
    vars: [["NEXT_PUBLIC_MAPBOX_TOKEN", "req", startsWith("pk.")]],
  },
  // Get Leads (Outscraper) is parked (GET_LEADS_PARKED in
  // src/lib/get-leads/business-types.ts). To un-park, restore:
  //   { title: "Get Leads prospecting (Outscraper)", tier: "feature",
  //     off: "Get Leads searches return 'not configured' (page still renders; feature is also agency-gated per sub-account)",
  //     vars: [["OUTSCRAPER_API_KEY", "req"]],
  //     deep(add, env) { if (env.has("OUTSCRAPER_API_KEY") && !env.has("NEXT_PUBLIC_MAPBOX_TOKEN")) add("warn", "NEXT_PUBLIC_MAPBOX_TOKEN isn't set: Get Leads works, but without the results map or typed-location search (browser geolocation only)"); } },
  {
    title: "Live chat / support (Crisp)",
    tier: "feature",
    off: "the support chat widget doesn't load",
    vars: [["NEXT_PUBLIC_CRISP_WEBSITE_ID", "req"]],
  },
  {
    title: "Marketing tracking (optional)",
    tier: "feature",
    off: "no Pixel / GTM tags fire",
    independent: true,
    vars: [
      ["NEXT_PUBLIC_META_PIXEL_ID", "opt", isNumeric],
      ["NEXT_PUBLIC_GTM_ID", "opt", startsWith("GTM-")],
      ["NEXT_PUBLIC_GOOGLE_TAG_ID", "opt", (v) =>
        /^(AW|G)-[A-Z0-9]+$/.test(v)
          ? null
          : `expected "AW-…" (Google Ads) or "G-…" (GA4) — double-check the paste`],
    ],
  },
  {
    title: "Push notifications (PWA)",
    tier: "feature",
    off: "the installed app works, but no push notifications fire",
    vars: [
      // Generate once: npx web-push generate-vapid-keys. The public key is inlined at
      // build time, so redeploy after setting it.
      ["NEXT_PUBLIC_VAPID_PUBLIC_KEY", "req"],
      ["VAPID_PRIVATE_KEY", "req"],
    ],
  },

  // LeadStack demo only: shown just when LANDING_VARIANT === "leadstack". The
  // setup routes filter on `group.variant`; the catalog itself doesn't.
  {
    title: "Founders deal (LeadStack demo)",
    tier: "feature",
    variant: "leadstack",
    independent: true,
    off: "the founders card shows only real Stripe sales (no manual offset)",
    vars: [
      // Added to the Stripe founders count for sales closed off Stripe (Skool,
      // invoices). Build-time inlined, so changes need a redeploy.
      ["NEXT_PUBLIC_FOUNDERS_MANUAL_SOLD", "opt", isNumeric],
    ],
  },
  {
    // Cloud control plane; shown only when LANDING_VARIANT === "leadstack".
    // CLOUD_VERCEL_TOKEN stays separate from the setup form's VERCEL_TOKEN.
    // GITHUB_TOKEN is also needed for provisioning + release promotion.
    title: "LeadStack Cloud (LeadStack demo)",
    tier: "feature",
    variant: "leadstack",
    independent: true,
    off: "Cloud checkout 503s and the fleet console shows 'not configured'",
    vars: [
      ["STRIPE_CLOUD_PRICE_ID", "opt", startsWith("price_")],
      ["CLOUD_VERCEL_TOKEN", "opt"],
      ["CLOUD_VERCEL_TEAM_ID", "opt"],
      // Defaults to leadstack.cloud.
      ["CLOUD_FLEET_DOMAIN", "opt"],
      // Defaults to the org template repo (owner/name).
      ["CLOUD_TEMPLATE_REPO", "opt"],
      // Secret for the dedicated commissions endpoint
      // (/api/webhooks/stripe/commissions: invoice.paid + charge.refunded). Without
      // it Cloud subscriptions are attributed but never credited.
      ["STRIPE_COMMISSIONS_WEBHOOK_SECRET", "opt", startsWith("whsec_")],
    ],
  },
];


export const KNOWN_KEYS = GROUPS.flatMap((g) => g.vars.map((v) => v[0]));

/** Preflight vars; never written via the setup form. */
export const NON_WRITABLE_KEYS = new Set(
  GROUPS.filter((g) => g.tier === "preflight").flatMap((g) =>
    g.vars.map((v) => v[0]),
  ),
);

/** Warning if the value looks off; null if fine, unknown, or no validator. */
export function validateVar(name, value) {
  for (const g of GROUPS) {
    for (const [varName, , check] of g.vars) {
      if (varName === name) {
        if (!check) return null;
        if (!isPresent(value)) return null; // don't validate an empty value
        return check(value.trim());
      }
    }
  }
  return null;
}

// Group evaluation. getValue(name) returns the raw string or undefined.

/** Same logic as the doctor CLI so both agree on the status. */
export function evaluateGroup(group, getValue) {
  const val = (k) => (getValue(k) ?? "").trim();
  const has = (k) => isPresent(getValue(k));
  const env = { has, val };

  const notes = [];
  const add = (level, msg) => notes.push({ level, msg });

  const req = group.vars.filter((v) => v[1] === "req");
  const rec = group.vars.filter((v) => v[1] === "rec");
  const reqPresent = req.filter((v) => has(v[0]));
  const missingReq = req.filter((v) => !has(v[0])).map((v) => v[0]);
  const missingRec = rec.filter((v) => !has(v[0])).map((v) => v[0]);
  const anyPresent = group.vars.some((v) => has(v[0]));

  for (const [name, , check] of group.vars) {
    if (check && has(name)) {
      const w = check(val(name));
      if (w) add("warn", `${name}: ${w}`);
    }
  }
  if (group.deep) group.deep(add, env);

  let status;
  if (group.tier === "boot") {
    if (missingReq.length || notes.some((n) => n.level === "error")) status = "error";
    else if (missingRec.length || notes.some((n) => n.level === "warn")) status = "check";
    else status = "ok";
  } else if (group.independent) {
    status = anyPresent ? "ok" : "off";
  } else {
    // For feature and preflight tiers, off is fine and partial means check.
    if (reqPresent.length === 0) status = "off";
    else if (reqPresent.length < req.length) status = "check";
    else status = notes.some((n) => n.level === "warn" || n.level === "error") ? "check" : "ok";
  }

  return {
    status,
    notes,
    missingReq,
    missingRec,
    reqPresent: reqPresent.length,
    reqTotal: req.length,
  };
}
