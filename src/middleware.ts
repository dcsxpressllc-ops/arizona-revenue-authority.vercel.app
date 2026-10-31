import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authMiddleware } from "next-firebase-auth-edge/lib/next/middleware";

const PUBLIC_PATHS = [
  "/",
  "/login",
  "/signup",
  "/terms",
  "/privacy",
  "/security",
  "/api-webhooks",
  "/about",
  "/thank-you",
  // Affiliate "Buy now" link (/buy?ref=CODE): sets the referral cookie, then
  // bounces to Stripe checkout.
  "/buy",
  // Pre-checkout details step (email/phone/address before Stripe).
  "/checkout",
  // Webinar-only founders landing. Unlinked + noindex.
  "/founderx",
  // Webinar registration landing (form posts to webinar1.dev). Unlinked + noindex.
  "/webinar",
  // Cold-traffic letter landing. Unlinked + noindex, ads only.
  "/flatpack",
  // /flatpack with a different hero. Unlinked + noindex, ads only.
  "/switch",
  // Public docs, e.g. /docs/updating (linked from /thank-you).
  "/docs",
  "/f",
  "/api/forms",
  "/api/auth/signup",
  // Workflow step worker. QStash callback, signature checked in the route.
  "/api/workflows/step",
  "/api/broadcasts/email/step",
  "/api/checkout",
  // Cloud onboarding wizard + API. No session yet: the claim token from the
  // purchase email is the credential (hash-checked in the routes). Heartbeat and
  // domain APIs under the same prefix use per-instance bearer tokens.
  // /api/cloud-instance is deliberately NOT public; it needs an owner session.
  "/cloud",
  "/api/cloud",
  "/api/cron/gitpage-heartbeat",
  // Daily sweep of the public API's TTL'd collections (apiRequestLogs,
  // apiIdempotency, webhookEvents). Used instead of native Firestore TTL so no
  // console setup is needed. Signature-verified in the route.
  "/api/cron/api-cleanup",
  // Daily usage month-close, charges and reminders. QStash signature checked in the route.
  "/api/cron/usage-close",
  // Hourly follow-up watchdog sweep. QStash, signature checked in the route.
  "/api/agents/watchdog/step",
  // Google Calendar import sweep; QStash signature checked in the route.
  "/api/google/calendar-import/step",
  "/api/landing/metrics",
  "/api/landing/recent-purchases",
  // Live-visitor heartbeat from landing pages (~5s). Failures are swallowed in
  // the route so the landing page never breaks.
  "/api/landing/heartbeat",
  // /flatpack funnel counters, one beacon per step per visitor.
  "/api/flatpack/event",
  // /switch funnel counters (own collection).
  "/api/switch/event",
  // Time-on-page counters for home + /flatpack.
  "/api/landing/engagement",
  // Ad-click attribution events; data comes from the visitor's cookie.
  "/api/landing/ad-event",
  "/api/webhooks/twilio",
  "/api/webhooks/stripe",
  // PayPal webhook. PayPal signature verified in the route.
  "/api/webhooks/paypal",
  // Meta (Messenger + Instagram DM) webhook. GET is the verify-token handshake,
  // POST carries events. X-Hub-Signature-256 checked in the route; routed per
  // sub-account by Page / IG id.
  "/api/webhooks/meta",
  // Resend inbound email. Svix signature (RESEND_WEBHOOK_SECRET) checked in the
  // route; routed by the capture address's domain to resendConfig.domainName.
  "/api/webhooks/resend",
  // Post-payment GitHub invite, POSTed from /thank-you. The claim token in the
  // body must hash-match purchases/{sessionId}; 3 failed attempts locks it.
  "/api/github",
  // Vapi webhooks. Each route checks Authorization: Bearer ${VAPI_WEBHOOK_SECRET},
  // and the [subAccountId] path param limits a leaked secret to one sub-account.
  "/api/webhooks/vapi",
  // Web Voice custom-LLM endpoint. Secured in the route by a per-sub-account
  // secret path segment plus an HMAC session token from /api/web-chat/voice/start.
  "/api/webhooks/elevenlabs",
  // Web chat widget API. Origin checked against the sub-account's allowedDomains,
  // per-IP + per-session rate limits, anonymous until a [[capture ...]] marker.
  "/api/web-chat",
  // Chat widget iframe target. Can't send anything without passing the
  // /api/web-chat origin check.
  "/embed",
  "/widget.js",
  // PWA manifest and service worker are fetched without credentials (including
  // on /login). Harmless: branding metadata and push-display code.
  "/manifest.webmanifest",
  "/sw.js",
  // App icons, fetched by the OS/browser without credentials. Read-only.
  "/api/pwa",
  // Uploaded agency/workspace logos, embedded in emails and public pages. Read-only.
  "/api/brand/logo",
  "/u",
  "/api/u",
  // Public quote view /q/[token] + accept/decline. HMAC token checked in the route.
  "/q",
  "/api/quotes",
  // Public booking pages /b/[saId]/[slug] + availability/book POSTs. Only
  // published pages return slots, POSTs are rate-limited per IP, and booking
  // re-checks the slot in a transaction to prevent double-booking.
  "/b",
  "/api/booking",
  // Public funnel pages /fn/[saId]/[slug] + thanks page. Read-only; the CTA hands
  // off to /co. 404 unless published AND the Labs gate is on, so turning the
  // gate off takes every funnel offline.
  "/fn",
  // Vanity-subdomain resolver (target of the host rewrite). Same gating as /fn.
  "/fnh",
  // Public checkout pages /co/[saId]/[slug] + session-create POST. Visitors aren't
  // logged in. 404 unless published and the Payments gate is on; prices and bumps
  // are re-read server-side (the body only says which bumps were ticked); the
  // session POST is rate-limited per IP. Card details stay on Stripe's page.
  "/co",
  "/api/co",
  // Public Sell Online catalog (read-only, 404 when selling is off).
  "/api/products-feed",
  // QStash ticks for AI product images (signature-verified).
  "/api/products/images/poll",
  // QStash ticks telling gitpage to re-sync website shop pages (signature-verified).
  "/api/products/sync-notify",
  // Public event page /e/[token] + cancel/reschedule. HMAC token must match
  // event.publicTokenHash; reschedule rotates the token so old links die.
  "/e",
  // Booking reminder + payment auto-expire QStash callbacks (signature checked
  // in the route).
  "/api/events/reminder",
  "/api/events/payment",
  "/api/dev-only/danger-wipe-everything",
  // Served from src/app/robots.ts and sitemap.ts; crawlers must reach them.
  "/robots.txt",
  "/sitemap.xml",
  // Affiliate program uses its own magic-link cookie, not Firebase Auth. Checked
  // in each route/page.
  "/affiliate",
  "/api/affiliate",
  // Community member surface: own magic-link cookie scoped to the sub-account, not
  // Firebase Auth. Checked in each route/page; a member session can never reach
  // the staff /sa/* surface.
  "/c",
  "/api/community",
  // Client billing checkout + status page. The HMAC token in the URL is the
  // credential (checked against billing.checkoutTokenHash); a valid link 303s to
  // Stripe Checkout.
  "/pay",
  // Public REST API. Bearer-token auth inside each route (lib/api/auth.ts), with
  // tenancy enforced in code since Admin SDK writes bypass rules. Listed here so
  // API-key callers aren't redirected to /login.
  "/api/v1",
  // Outbound-webhook delivery worker. QStash only, verified via
  // verifyQStashSignature in the route.
  "/api/webhooks-out",
];

// Public paths with params. Webhook/QStash endpoints secured by signature
// checks inside the route, not by session.
const PUBLIC_PATH_PATTERNS: RegExp[] = [
  // Bulk outbound-call step (QStash).
  /^\/api\/comms\/voice\/campaign\/step$/,
  // Gitpage bonus reminder (QStash).
  /^\/api\/gitpage-reminder\/step$/,
  // Gitpage build poll.
  /^\/api\/sub-accounts\/[^/]+\/website\/[^/]+\/poll$/,
  // Gitpage build.settled callback, HMAC-signed with GITPAGE_API_KEY.
  /^\/api\/webhooks\/gitpage\/build-settled$/,
  // Post-publish PageSpeed check. QStash-signed; manual re-checks carry a session
  // and are admin-checked in the route.
  /^\/api\/sub-accounts\/[^/]+\/website\/[^/]+\/pagespeed$/,
  // Social Planner publish step (QStash).
  /^\/api\/social\/publish\/step$/,
  // GHL migration drain (QStash).
  /^\/api\/import\/ghl\/step$/,
  // WhatsApp template approval poll (QStash).
  /^\/api\/sub-accounts\/[^/]+\/whatsapp-templates\/poll$/,
  // Per-sub-account Stripe webhook (separate from the agency's /api/webhooks/stripe).
  // Signature checked against that sub-account's own signing secret.
  /^\/api\/webhooks\/stripe\/sa\/[^/]+$/,
  // Per-sub-account Webinar1 webhook. X-Webinar1-Signature checked against that
  // sub-account's signing secret.
  /^\/api\/webhooks\/webinar1\/sa\/[^/]+$/,
  // Booking deposit payment. A regex on purpose: a /api/events prefix would also
  // expose /api/events/by-id/{id}/mark-paid etc. HMAC event token checked in the route.
  /^\/api\/events\/[^/]+\/pay$/,
  // Cancel/reschedule buttons on the public /e/[token] page; same token check.
  /^\/api\/events\/[^/]+\/(cancel|reschedule)$/,
  // Calendar .ics feed. Calendar pollers can't send cookies, so the HMAC token in
  // ?t= is the credential (verifyCalendarFeedToken).
  /^\/api\/sub-accounts\/[^/]+\/calendar\.ics$/,
  // Competitor comparison pages (/leadstack-vs-*). Hyphen-suffixed slugs can't be
  // prefix-matched, hence the regex. Read-only.
  /^\/leadstack-vs-[a-z0-9-]+$/,
  // SEO pages below are variant-gated inside the route.
  /^\/gohighlevel-alternatives$/,
  /^\/go-high-level-pricing$/,
  // Feature inventory page. Unlinked + noindex; 404s outside the LeadStack variant.
  /^\/feature-map$/,
];

function isPublicPath(pathname: string): boolean {
  if (
    PUBLIC_PATHS.some(
      (path) => pathname === path || pathname.startsWith(`${path}/`)
    )
  ) {
    return true;
  }
  return PUBLIC_PATH_PATTERNS.some((re) => re.test(pathname));
}

/**
 * Vanity funnel subdomain from the Host header, or null. Only single-label
 * subdomains of the app host; never `www` or the apex. `*.localhost` works too,
 * so it's testable without DNS. No DB access at the edge: the /fnh resolver
 * does the claim lookup, so unclaimed subdomains 404 there.
 */
function funnelSubdomainFrom(request: NextRequest): string | null {
  const host = request.headers.get("host")?.toLowerCase().split(":")[0];
  if (!host) return null;

  let root: string;
  try {
    root = new URL(process.env.NEXT_PUBLIC_APP_URL ?? "").hostname
      .toLowerCase()
      .replace(/^www\./, "");
  } catch {
    root = "localhost";
  }

  for (const base of [root, "localhost"]) {
    if (host === base || host === `www.${base}`) return null;
    if (host.endsWith(`.${base}`)) {
      const sub = host.slice(0, -(base.length + 1));
      if (sub && !sub.includes(".") && sub !== "www") return sub;
    }
  }
  return null;
}

/**
 * Identity headers trusted by lib/auth/require-* and comms/route-auth. Only
 * handleValidToken may set them. Clients can forge them, so every pass-through
 * branch must strip them; a bare NextResponse.next() would forward x-user-uid.
 */
const IDENTITY_HEADERS = ["x-user-uid", "x-user-email"];

function withoutIdentityHeaders(request: NextRequest): Headers {
  const headers = new Headers(request.headers);
  for (const name of IDENTITY_HEADERS) headers.delete(name);
  return headers;
}

export default function middleware(request: NextRequest) {
  const cleanHeaders = withoutIdentityHeaders(request);
  const passThrough = () =>
    NextResponse.next({ request: { headers: cleanHeaders } });

  // Only the root path is rewritten on vanity hosts. Everything else (/co, /api,
  // /_next) is host-agnostic, which keeps checkout working on the subdomain.
  if (request.nextUrl.pathname === "/") {
    const sub = funnelSubdomainFrom(request);
    if (sub) {
      return NextResponse.rewrite(new URL(`/fnh/${sub}`, request.url), {
        request: { headers: cleanHeaders },
      });
    }
  }

  // Skip auth middleware if Firebase is not configured
  if (
    !process.env.NEXT_PUBLIC_FIREBASE_API_KEY ||
    !process.env.FIREBASE_ADMIN_PROJECT_ID
  ) {
    return passThrough();
  }

  return authMiddleware(request, {
    loginPath: "/api/login",
    logoutPath: "/api/logout",
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    cookieName: "__session",
    cookieSignatureKeys: [
      process.env.COOKIE_SECRET_CURRENT ?? "",
      process.env.COOKIE_SECRET_PREVIOUS ?? "",
    ],
    cookieSerializeOptions: {
      path: "/",
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 12 * 60 * 60 * 24, // 12 days
    },
    serviceAccount: {
      projectId: process.env.FIREBASE_ADMIN_PROJECT_ID ?? "",
      clientEmail: process.env.FIREBASE_ADMIN_CLIENT_EMAIL ?? "",
      privateKey: (process.env.FIREBASE_ADMIN_PRIVATE_KEY ?? "").replace(
        /\\n/g,
        "\n"
      ),
    },
    handleValidToken: async ({ decodedToken }, headers) => {
      headers.set("x-user-uid", decodedToken.uid);
      headers.set("x-user-email", decodedToken.email ?? "");

      return NextResponse.next({ request: { headers } });
    },
    handleInvalidToken: async () => {
      const pathname = request.nextUrl.pathname;

      if (isPublicPath(pathname)) {
        return passThrough();
      }

      const url = request.nextUrl.clone();
      url.pathname = "/login";
      url.searchParams.set("redirect", pathname);
      return NextResponse.redirect(url);
    },
    handleError: async () => {
      const pathname = request.nextUrl.pathname;

      // On error, allow public paths and redirect protected paths
      if (isPublicPath(pathname)) {
        return passThrough();
      }

      const url = request.nextUrl.clone();
      url.pathname = "/login";
      url.searchParams.set("redirect", pathname);
      return NextResponse.redirect(url);
    },
  });
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
    // All API routes, even ones ending in an image extension. The line above skips
    // those, and a skipped request would reach the route with a forged x-user-uid.
    "/api/:path*",
    "/api/login",
    "/api/logout",
  ],
};
