import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { LANDING_VARIANT } from "@/config/landing";

/**
 * Unlinked, noindexed inventory of every LeadStack feature, for sharing with
 * prospects. 404s under the "custom" landing variant, like /about.
 * Content mirrors the AI Suite KB (src/lib/ai-suite/knowledge-base.ts); update
 * both by hand when a feature ships or changes.
 */
export const metadata: Metadata = {
  title: "LeadStack Feature Map",
  description:
    "A granular, grouped inventory of every shipped LeadStack feature.",
  robots: { index: false, follow: false },
};

const GROUPS: {
  id: string;
  title: string;
}[] = [
  { id: "contacts-data", title: "Contacts & Data" },
  { id: "pipeline-deals", title: "Pipeline & Deals" },
  { id: "calendar-booking", title: "Calendar & Booking" },
  { id: "tasks-forms", title: "Tasks & Forms" },
  { id: "sales-payments", title: "Sales & Payments" },
  { id: "channels", title: "Messaging Channels" },
  { id: "ai-agents", title: "AI Agents (Client-Facing)" },
  { id: "ai-suite", title: "AI Suite (Internal Assistants)" },
  { id: "automation", title: "Automation" },
  { id: "growth-content", title: "Growth & Content" },
  { id: "reporting", title: "Reporting & Insight" },
  { id: "agency", title: "Agency & Multi-Tenancy" },
  { id: "platform", title: "Account & Platform" },
  { id: "developer", title: "Developer & Integrations" },
];

export default function FeatureMapPage() {
  if (LANDING_VARIANT !== "leadstack") {
    notFound();
  }

  return (
    <div className="feature-map-page">
      <style>{CSS}</style>

      <div className="page">
        <header className="hero">
          <p className="eyebrow">Internal reference — LeadStack CRM</p>
          <h1 className="title">The Feature Map</h1>
          <p className="dek">
            Every shipped surface in LeadStack, grouped the way the product
            actually works rather than how the sidebar lists it.
          </p>
          <div className="stat-row">
            <div className="stat">
              <span className="num">14</span>
              <span className="label">Feature areas</span>
            </div>
            <div className="stat">
              <span className="num">80+</span>
              <span className="label">Granular capabilities</span>
            </div>
            <div className="stat">
              <span className="num">7</span>
              <span className="label">AI-driven channels</span>
            </div>
            <div className="stat">
              <span className="num">1</span>
              <span className="label">One-time license, no per-seat fees</span>
            </div>
          </div>
        </header>

        <div className="layout">
          <nav className="toc">
            {GROUPS.map((g, i) => (
              <a key={g.id} href={`#${g.id}`}>
                <span className="n">{String(i + 1).padStart(2, "0")}</span>
                <span>{g.title}</span>
              </a>
            ))}
          </nav>

          <main>
            <section className="group" id="contacts-data">
              <div className="group-head">
                <h2>Contacts &amp; Data</h2>
                <span className="group-count">5 features</span>
              </div>
              <p className="group-note">
                The record of who a client&apos;s leads and customers are, and
                the fields, geography, and territory rules layered on top of
                that record.
              </p>

              <div className="feature">
                <div className="feature-head">
                  <h3>Contacts</h3>
                </div>
                <p>
                  Every lead and customer for the workspace, with a unified
                  activity timeline.
                </p>
                <ul>
                  <li>
                    Profile actions: one-off email, one-off SMS, browser call,
                    AI click-to-call, Google review request
                  </li>
                  <li>
                    Four-state SMS consent tracking — form-consented (with
                    wording/date/page on record), form-declined, carrier
                    opt-out (STOP), or never asked
                  </li>
                  <li>
                    Delete guard: a contact linked to deals, tasks, events,
                    quotes, conversations, or calls can&apos;t be deleted
                    until those are cleared (form submissions cascade
                    automatically)
                  </li>
                  <li>
                    Merge action for contacts that arrived as a bare
                    Facebook/Instagram DM identity
                  </li>
                  <li>
                    CSV import with column matching, CSV export, bulk email by
                    audience filter, bulk AI voice call by audience filter
                  </li>
                  <li>
                    Source badges (Web Chat, Booking, Form, WhatsApp,
                    Webinar…) and captured UTM/referrer attribution
                  </li>
                </ul>
              </div>

              <div className="feature">
                <div className="feature-head">
                  <h3>Custom fields</h3>
                  <span className="loc">Settings → Custom Fields</span>
                </div>
                <p>
                  Admin-defined fields on contacts and deals — text, number,
                  date, dropdown, required or optional — surfaced on every
                  add/edit form and read-only on the contact&apos;s Details
                  card.
                </p>
              </div>

              <div className="feature">
                <div className="feature-head">
                  <h3>Phone region</h3>
                  <span className="loc">Settings → Admin</span>
                </div>
                <p>
                  Sets the default country for numbers typed without a
                  country code, so forms, imports, and chat captures store
                  E.164 numbers that match inbound SMS/WhatsApp caller IDs.
                </p>
              </div>

              <div className="feature">
                <div className="feature-head">
                  <h3>Territory scoping</h3>
                  <span className="tag admin">Admin</span>
                </div>
                <p>
                  Opt-in restriction pinning collaborators to assigned
                  territories — they only see contacts and deals inside them,
                  while admins and the agency owner always see everything.
                </p>
              </div>

              <div className="feature">
                <div className="feature-head">
                  <h3>GoHighLevel migration import</h3>
                  <span className="loc">Settings → Importer</span>
                </div>
                <p>
                  Pulls contacts (with custom fields and tags), deals with
                  pipeline-stage mapping, and notes across from a GHL
                  sub-account via a Private Integration Token, previewed
                  before it runs in the background.
                </p>
              </div>
            </section>

            <section className="group" id="pipeline-deals">
              <div className="group-head">
                <h2>Pipeline &amp; Deals</h2>
                <span className="group-count">2 features</span>
              </div>
              <p className="group-note">
                Where opportunities move from first contact to won or lost.
              </p>

              <div className="feature">
                <div className="feature-head">
                  <h3>Pipeline (Kanban)</h3>
                </div>
                <p>
                  Drag-and-drop board, six default stages (New → Contacted →
                  Qualified → Proposal → Won / Lost), value and
                  days-in-stage on every card, and a lost-reason prompt on
                  drop.
                </p>
              </div>

              <div className="feature">
                <div className="feature-head">
                  <h3>Multiple pipelines &amp; custom stages</h3>
                  <span className="tag beta">Beta</span>
                </div>
                <p>
                  Up to 10 pipelines per workspace with up to 12 custom
                  stages each — e.g. a Sales pipeline next to a Fulfillment
                  pipeline — each keeping exactly one renameable Won and one
                  Lost terminal stage that reports and quote automation key
                  off.
                </p>
              </div>
            </section>

            <section className="group" id="calendar-booking">
              <div className="group-head">
                <h2>Calendar &amp; Booking</h2>
                <span className="group-count">3 features</span>
              </div>
              <p className="group-note">
                Getting a real appointment onto a real calendar, without a
                double-booked slot.
              </p>

              <div className="feature">
                <div className="feature-head">
                  <h3>Calendar</h3>
                </div>
                <p>
                  Month grid of workspace events, linkable to a contact,
                  populated by manual entries, public bookings, and
                  voice-agent bookings alike.
                </p>
              </div>

              <div className="feature">
                <div className="feature-head">
                  <h3>Booking pages</h3>
                </div>
                <p>
                  Calendly-style public slot picker with server-reverified
                  availability, ICS confirmation emails, and automatic
                  reschedule/cancel/reminder handling.
                </p>
                <ul>
                  <li>Five visual style presets, matching Checkout&apos;s presets</li>
                  <li>
                    Team pages: add multiple hosts, auto-assign to whoever&apos;s
                    least busy
                  </li>
                  <li>
                    Optional &ldquo;let customers pick a specific person&rdquo;
                    host selector, off by default
                  </li>
                  <li>Per-host custom hours, overriding the page&apos;s shared hours</li>
                  <li>
                    Paid-deposit holds with expiry, and a default booking
                    link that powers the <code>{"{{bookingLink}}"}</code> merge
                    tag everywhere
                  </li>
                </ul>
              </div>

              <div className="feature">
                <div className="feature-head">
                  <h3>Google Calendar sync</h3>
                  <span className="tag beta">Beta</span>
                </div>
                <p>
                  Per-member, two-way OAuth connection: a member&apos;s own
                  Google busy times block their booking-page slots (per-host
                  on team pages), and new bookings push to their Google
                  Calendar within seconds — only opaque busy blocks are
                  read, never event details. Falls back to a read-only .ics
                  feed if unconfigured, and fails open (never blocks
                  bookings) if a connection breaks.
                </p>
              </div>
            </section>

            <section className="group" id="tasks-forms">
              <div className="group-head">
                <h2>Tasks &amp; Forms</h2>
                <span className="group-count">2 features</span>
              </div>
              <p className="group-note">
                The two places new work and new leads enter the system.
              </p>

              <div className="feature">
                <div className="feature-head">
                  <h3>Tasks</h3>
                </div>
                <p>
                  Today / Overdue / Upcoming / Done, contact-linkable, with a
                  sidebar due-today badge. Auto-created by lead-capture,
                  interested outbound calls, and the Follow-up Watchdog.
                </p>
              </div>

              <div className="feature">
                <div className="feature-head">
                  <h3>Forms</h3>
                </div>
                <p>
                  Drag-order field builder mapping straight onto contact
                  fields, with a public hosted page and an iframe embed.
                </p>
                <ul>
                  <li>
                    A2P-style SMS-consent checkbox that records the exact
                    wording, date, and page when ticked
                  </li>
                  <li>
                    Always-on spam protection with nothing to configure:
                    honeypot field, too-fast-to-submit check, per-IP rate
                    limit — no captcha option
                  </li>
                  <li>
                    Auto-creates a contact (and optionally a deal), captures
                    marketing attribution, can trigger a workflow
                  </li>
                </ul>
              </div>
            </section>

            <section className="group" id="sales-payments">
              <div className="group-head">
                <h2>Sales &amp; Payments</h2>
                <span className="group-count">4 features</span>
              </div>
              <p className="group-note">
                Turning a deal into collected money, through the client&apos;s
                own Stripe — never the agency&apos;s.
              </p>

              <div className="feature">
                <div className="feature-head">
                  <h3>Products catalog</h3>
                </div>
                <p>
                  Reusable products (name, price, currency); &ldquo;Add from
                  catalog&rdquo; snapshots one into a quote or invoice line so
                  later price edits never rewrite history.
                </p>
              </div>

              <div className="feature">
                <div className="feature-head">
                  <h3>Quotes &amp; Invoices</h3>
                </div>
                <p>
                  Line-itemed quotes (Q-YYYY-NNNN) sent by email, publicly
                  accepted or declined with a reason, and convertible to
                  invoices (INV-, no accept step).
                </p>
                <ul>
                  <li>
                    Optional link to a pipeline deal — acceptance moves that
                    deal to Won at the quote total, no duplicate deal created
                  </li>
                  <li>
                    Card payment via the workspace&apos;s own Stripe, or a
                    PayPal.me link with manual mark-paid
                  </li>
                  <li>Can auto-fire a Google review request on payment</li>
                </ul>
              </div>

              <div className="feature">
                <div className="feature-head">
                  <h3>Checkout pages</h3>
                  <span className="tag gate">Agency-gated</span>
                </div>
                <p>
                  Public single-product sales page with up to three order
                  bumps, paid straight into the workspace&apos;s Stripe.
                </p>
                <ul>
                  <li>Five style presets (Clean, Midnight, Sunset, Ocean, Noir Lime)</li>
                  <li>
                    Bumps drawn only from active, bump-flagged products in
                    the same currency as the main offer
                  </li>
                  <li>
                    Draft/publish flow; buyers are created or matched as
                    contacts with optional auto-tag and pipeline stage
                  </li>
                </ul>
              </div>

              <div className="feature">
                <div className="feature-head">
                  <h3>Payments</h3>
                  <span className="tag gate">Agency-gated</span>
                </div>
                <p>
                  A workspace connects its own restricted Stripe key (no
                  Stripe Connect) to unlock card pay-buttons on invoices,
                  deposits on booking pages, checkout offers, and paid
                  community access — money lands in the client&apos;s own
                  Stripe account.
                </p>
              </div>
            </section>

            <section className="group" id="channels">
              <div className="group-head">
                <h2>Messaging Channels</h2>
                <span className="group-count">8 features</span>
              </div>
              <p className="group-note">
                Every wire a message can travel on, and the one inbox that
                reads them all.
              </p>

              <div className="feature">
                <div className="feature-head">
                  <h3>Conversations (unified inbox)</h3>
                </div>
                <p>
                  One inbox across SMS, WhatsApp, Web Chat, and — once
                  enabled — Facebook/Instagram DMs and two-way Email, each
                  thread with per-channel AI controls (auto / suggest a
                  draft / off) and manual takeover.
                </p>
              </div>

              <div className="feature">
                <div className="feature-head">
                  <h3>SMS &amp; WhatsApp setup</h3>
                </div>
                <p>
                  Dedicated Twilio number (paste your own Account
                  SID/Auth Token/From number) unlocks two-way SMS threads,
                  STOP/START opt-out handling, and the SMS AI channel.
                </p>
                <ul>
                  <li>
                    WhatsApp sender reuses the same Twilio credentials, with
                    a Templates manager for Meta-approved re-engagement
                    templates required outside the 24-hour session window
                  </li>
                </ul>
              </div>

              <div className="feature">
                <div className="feature-head">
                  <h3>Email sending domain &amp; two-way inbox</h3>
                  <span className="tag gate">Agency-gated</span>
                </div>
                <p>
                  Verify a workspace&apos;s own sending domain (SPF/DKIM DNS
                  records) so every automated and manual email leaves from
                  its brand, then optionally add an MX record to bring
                  replies back into Conversations as a sixth channel.
                </p>
              </div>

              <div className="feature">
                <div className="feature-head">
                  <h3>Web Chat widget</h3>
                </div>
                <p>
                  Embeddable chat bubble answering with the shared AI
                  persona plus a scraped website knowledge base; captures
                  name/email/phone via an inline form when a visitor wants a
                  callback, creating a contact, task, and escalation email.
                  Live sessions (including anonymous visitors) show in
                  Conversations for takeover.
                </p>
              </div>

              <div className="feature">
                <div className="feature-head">
                  <h3>Phone dialer</h3>
                  <span className="tag admin">Admin-enabled</span>
                </div>
                <p>
                  Outbound browser calling from a contact&apos;s profile over
                  the workspace&apos;s own Twilio number — mute, keypad,
                  hang-up, logged to the timeline. Recording is a separate
                  opt-in toggle, off by default.
                </p>
              </div>

              <div className="feature">
                <div className="feature-head">
                  <h3>Missed Call Text Back</h3>
                  <span className="tag gate">Agency-gated</span>
                </div>
                <p>
                  Auto-texts a caller who wasn&apos;t answered, with an
                  optional forward-first ring window — mutually exclusive
                  with the inbound Voice AI agent, since both would answer
                  the same line.
                </p>
              </div>

              <div className="feature">
                <div className="feature-head">
                  <h3>Broadcasts</h3>
                  <span className="tag gate">Agency-gated</span>
                </div>
                <p>
                  Bulk email to a filtered audience (all / a tag / a
                  pipeline stage) with a live skipped-recipient count and
                  per-recipient delivery status. No bulk SMS — bulk AI voice
                  calling covers that instead.
                </p>
              </div>

              <div className="feature">
                <div className="feature-head">
                  <h3>Google review requests</h3>
                </div>
                <p>
                  Sends a review-link message over SMS or WhatsApp, manually
                  from a contact&apos;s profile or automatically when a quote
                  is paid or a deal completes, respecting a 90-day
                  per-contact cooldown.
                </p>
              </div>
            </section>

            <section className="group" id="ai-agents">
              <div className="group-head">
                <h2>AI Agents (Client-Facing)</h2>
                <span className="group-count">6 features</span>
              </div>
              <p className="group-note">
                One persona, answering a client&apos;s own customers across
                every channel it&apos;s turned on for.
              </p>

              <div className="feature">
                <div className="feature-head">
                  <h3>Shared persona &amp; overview</h3>
                </div>
                <p>
                  One system prompt, business hours, escalation
                  keywords/email, and an optional scraped website knowledge
                  base, with a dry-run test console — every channel below
                  falls back to this unless it sets its own override.
                </p>
              </div>

              <div className="feature">
                <div className="feature-head">
                  <h3>Web Chat AI</h3>
                </div>
                <p>
                  On by default; answers the embeddable widget from the
                  shared persona plus the site knowledge base.
                </p>
              </div>

              <div className="feature">
                <div className="feature-head">
                  <h3>SMS &amp; WhatsApp AI</h3>
                </div>
                <p>
                  Auto-replies on the dedicated number within business
                  hours; WhatsApp replies still respect the 24-hour
                  session/template rule.
                </p>
              </div>

              <div className="feature">
                <div className="feature-head">
                  <h3>Messenger &amp; Instagram AI</h3>
                  <span className="tag gate">Agency-gated</span>
                </div>
                <p>
                  Answers inbound Facebook and Instagram DMs on one switch,
                  replying on whichever platform the message arrived on; a
                  missing Instagram permission degrades gracefully to
                  Messenger-only.
                </p>
              </div>

              <div className="feature">
                <div className="feature-head">
                  <h3>Voice AI — inbound &amp; live booking</h3>
                  <span className="tag beta">Not call-verified</span>
                </div>
                <p>
                  Answers inbound calls on the workspace&apos;s number,
                  captures callback requests, and — when a published
                  booking page is chosen — checks live availability and
                  books a real slot during the call itself, including a
                  named-host pick on team pages. Bookings are phone-only, so
                  every attempt creates a confirm-with-caller follow-up task
                  instead of an email.
                </p>
              </div>

              <div className="feature">
                <div className="feature-head">
                  <h3>Outbound Voice</h3>
                  <span className="tag gate">Agency-gated</span>
                </div>
                <p>
                  AI dials contacts proactively — single click-to-call or a
                  bulk campaign over a filtered audience — with its own
                  calling-hours window (per contact&apos;s local timezone),
                  call caps, a mandatory consent acknowledgment, and a
                  stop-all kill switch. An &ldquo;interested&rdquo; outcome
                  auto-creates a follow-up task.
                </p>
              </div>

              <div className="feature">
                <div className="feature-head">
                  <h3>Email AI (draft-only)</h3>
                </div>
                <p>
                  Suggests a reply to an inbound email from the two-way
                  inbox for a human to edit and approve — it never sends an
                  email on its own, even in Auto mode.
                </p>
              </div>
            </section>

            <section className="group" id="ai-suite">
              <div className="group-head">
                <h2>AI Suite (Internal Assistants)</h2>
                <span className="group-count">1 feature</span>
              </div>
              <p className="group-note">
                Not a bot for clients — a copilot for the person running the
                CRM, gated behind a confirmation card on every write.
              </p>

              <div className="feature">
                <div className="feature-head">
                  <h3>Workspace &amp; Agency Assistant</h3>
                  <span className="tag gate">Off by default</span>
                </div>
                <p>
                  Two chat assistants, both audit-logged and
                  confirm-before-every-action: the Workspace Assistant
                  (scoped to one sub-account) can search/add/update
                  contacts, snapshot the workspace, work deals and
                  pipelines, manage tasks and events, check
                  quotes/invoices/bookings, invite members, manage webhooks
                  and workflows, stand up a community, run the Follow-up
                  Watchdog, and even kick off a website build — all behind
                  confirmation cards. The Agency Assistant additionally
                  spans sub-accounts: create one, flip feature gates, manage
                  Client Billing plans and MRR, comp a client, mint checkout
                  links, and set usage limits. Neither can message a
                  customer or delete a record.
                </p>
              </div>
            </section>

            <section className="group" id="automation">
              <div className="group-head">
                <h2>Automation</h2>
                <span className="group-count">2 features</span>
              </div>
              <p className="group-note">
                What happens without anyone clicking a button.
              </p>

              <div className="feature">
                <div className="feature-head">
                  <h3>Workflows (visual builder)</h3>
                </div>
                <p>
                  Pick a trigger — form submitted, contact created, tag
                  added, deal stage changed, booking created/cancelled/
                  rescheduled, quote accepted, invoice paid, or message
                  received — then chain send-SMS, send-email,
                  send-WhatsApp-template, wait, and create-task steps.
                </p>
                <ul>
                  <li>If/else branching on contact conditions (ALL or ANY match)</li>
                  <li>
                    &ldquo;Wait for reply&rdquo; branching — takes the
                    Replied path the moment a contact answers on any
                    connected channel, or No-reply once the window ends
                  </li>
                  <li>
                    Re-enrollment control: every time / not while already
                    enrolled / only once
                  </li>
                  <li>
                    Starter templates: Speed-to-Lead, Appointment
                    Confirmation, Lead Nurture, Stage-Change Follow-up,
                    No-reply Follow-up
                  </li>
                  <li>Draft → Publish flow with a per-run history log</li>
                </ul>
              </div>

              <div className="feature">
                <div className="feature-head">
                  <h3>Sending preferences</h3>
                </div>
                <p>
                  Three workspace-wide controls: the Reply-To address every
                  automated email routes to, an optional sending-hours
                  window that holds messages until it opens, and a
                  &ldquo;pause all workflows&rdquo; emergency stop.
                </p>
              </div>
            </section>

            <section className="group" id="growth-content">
              <div className="group-head">
                <h2>Growth &amp; Content</h2>
                <span className="group-count">7 features</span>
              </div>
              <p className="group-note">
                The surfaces that bring people in and keep them around,
                beyond the core CRM loop.
              </p>

              <div className="feature">
                <div className="feature-head">
                  <h3>Social Planner</h3>
                  <span className="tag gate">Agency-gated, Meta-only</span>
                </div>
                <p>
                  Schedules and auto-publishes posts to a connected Facebook
                  Page and Instagram Business account, sharing the same
                  Meta connection as the DM inbox rather than a second one.
                </p>
              </div>

              <div className="feature">
                <div className="feature-head">
                  <h3>Community &amp; Courses</h3>
                  <span className="tag gate">Agency-gated</span>
                </div>
                <p>
                  A Skool-style space: group feed with custom post
                  categories, a classroom (sections + video lessons,
                  YouTube/Vimeo), a members directory, leaderboards/points,
                  and member-to-member DMs.
                </p>
                <ul>
                  <li>
                    Free or paid (one-time, via the workspace&apos;s own
                    Stripe or PayPal.me), open-join or approval-required
                  </li>
                  <li>Members join by magic link and are tied to a contact record</li>
                  <li>
                    Group mode toggle: full community, or &ldquo;Courses
                    only&rdquo; — hides the feed and leaderboards and
                    presents the group as a standalone course sales page
                    with a promo video and auto-built curriculum overview,
                    reversible with nothing deleted
                  </li>
                </ul>
              </div>

              <div className="feature">
                <div className="feature-head">
                  <h3>Website builder</h3>
                  <span className="tag gate">Agency-gated</span>
                </div>
                <p>
                  Builds a marketing site per sub-account via gitpage.site
                  — Local (multi-page) or VSL (single-page video funnel),
                  with niche templates for Gym &amp; Fitness, Home Services,
                  and Real Estate; up to 5 sites per sub-account.
                </p>
              </div>

              <div className="feature">
                <div className="feature-head">
                  <h3>Webinars (Webinar1 integration)</h3>
                  <span className="tag gate">Agency-gated</span>
                </div>
                <p>
                  Connects a workspace to its own self-hosted Webinar1
                  deployment: lists its evergreen webinars, registers a CRM
                  contact into one (Webinar1 runs the whole email sequence),
                  and syncs registrations/joins/completions/CTA-clicks back
                  onto the contact timeline.
                </p>
              </div>

              <div className="feature">
                <div className="feature-head">
                  <h3>Get Leads</h3>
                  <span className="tag beta">Parked</span>
                </div>
                <p>
                  Local-business prospecting by type, location, and radius
                  (Outscraper + Google Maps), enriching results with emails
                  and socials before a one-click import to contacts.
                  Currently hidden behind a flag pending revisit.
                </p>
              </div>

              <div className="feature">
                <div className="feature-head">
                  <h3>Quick Funnels</h3>
                  <span className="tag beta">Experimental (Labs)</span>
                </div>
                <p>
                  Form-driven three-step funnel (landing → offer →
                  thank-you) at its own public URL; the offer step always
                  references a real Checkout page, so payment still runs
                  through the single Stripe path rather than a parallel
                  one.
                </p>
              </div>

              <div className="feature">
                <div className="feature-head">
                  <h3>Agent monitors</h3>
                  <span className="tag beta">Beta</span>
                </div>
                <p>
                  Under AI Agents → Monitors: hourly background agents that
                  flag customer messages nobody answered past a threshold
                  (AI judges which genuinely need attention) and deals that
                  have sat in one stage with no task, message or activity
                  (rules decide; AI writes the suggested next step). Each
                  flag is a task plus a push — they only ever add, never
                  message a customer or edit a record.
                </p>
              </div>
            </section>

            <section className="group" id="reporting">
              <div className="group-head">
                <h2>Reporting &amp; Insight</h2>
                <span className="group-count">4 features</span>
              </div>
              <p className="group-note">
                Seeing what the workspace is actually doing.
              </p>

              <div className="feature">
                <div className="feature-head">
                  <h3>Reports</h3>
                </div>
                <p>
                  Overview tab (date-range KPIs, pipeline funnel,
                  won-revenue chart, leads-by-source donut), an Attribution
                  tab (first-touch revenue attribution tied to UTM
                  source/campaign), and — with Payments on — a Payments tab
                  summarizing what&apos;s been collected by card.
                </p>
              </div>

              <div className="feature">
                <div className="feature-head">
                  <h3>Dashboard</h3>
                </div>
                <p>
                  Workspace home: KPI summary, default-pipeline snapshot,
                  recent contacts, quick actions, and a clustered leads map
                  of where contacts came from.
                </p>
              </div>

              <div className="feature">
                <div className="feature-head">
                  <h3>Logs</h3>
                </div>
                <p>
                  Delivery history for the public API and outbound
                  webhooks — HTTP status, error, retries — with a redeliver
                  action once an endpoint is fixed.
                </p>
              </div>

              <div className="feature">
                <div className="feature-head">
                  <h3>Global search</h3>
                </div>
                <p>
                  Cmd/Ctrl+K command palette across contacts, deals, tasks,
                  events, and forms from anywhere in the app.
                </p>
              </div>
            </section>

            <section className="group" id="agency">
              <div className="group-head">
                <h2>Agency &amp; Multi-Tenancy</h2>
                <span className="group-count">8 features</span>
              </div>
              <p className="group-note">
                Running many isolated client workspaces from one deployment.
              </p>

              <div className="feature">
                <div className="feature-head">
                  <h3>Sub-accounts</h3>
                </div>
                <p>
                  Each client is a fully isolated workspace with its own
                  contacts, pipeline, and data — created, renamed, and
                  deleted (blocked while records remain) from Agency →
                  Sub-accounts.
                </p>
              </div>

              <div className="feature">
                <div className="feature-head">
                  <h3>Snapshots</h3>
                </div>
                <p>
                  Captures a proven sub-account&apos;s forms, templates,
                  products, and workflows (never customer data or
                  credentials) into a reusable template applied when
                  spinning up a new client.
                </p>
              </div>

              <div className="feature">
                <div className="feature-head">
                  <h3>Feature gates</h3>
                </div>
                <p>
                  Per-sub-account switches for every revenue- or
                  resource-consuming feature — email domains, API access,
                  broadcasts, WhatsApp, outbound voice, websites, the Meta
                  inbox and its AI, Social Planner, Community, Missed-Call
                  Text-Back, Payments, Webinars, the Workspace Assistant,
                  Agent monitors, and Labs — with a choice to show
                  &ldquo;Locked&rdquo; or hide the entry entirely.
                </p>
              </div>

              <div className="feature">
                <div className="feature-head">
                  <h3>Members &amp; invites</h3>
                </div>
                <p>
                  Email invites per sub-account with two roles (admin,
                  collaborator); the agency owner has implicit admin
                  everywhere.
                </p>
              </div>

              <div className="feature">
                <div className="feature-head">
                  <h3>Client billing</h3>
                </div>
                <p>
                  Charges each sub-account a monthly subscription through
                  the agency&apos;s own Stripe account — plans bundle
                  feature gates and, optionally, included usage with a
                  per-unit overage rate.
                </p>
                <ul>
                  <li>
                    Per-client special pricing, prorated plan switches, and
                    a &ldquo;comped&rdquo; (unbilled) default state
                  </li>
                  <li>
                    Secure checkout links, a 7-day grace period on failed
                    renewals, then a paywall with no data loss
                  </li>
                  <li>One-off charges outside any plan (e.g. &ldquo;Web design — $500&rdquo;)</li>
                </ul>
              </div>

              <div className="feature">
                <div className="feature-head">
                  <h3>Usage limits &amp; metering</h3>
                </div>
                <p>
                  Tracks monthly email, SMS, WhatsApp, AI-token, and
                  voice-minute consumption per workspace; unlimited until a
                  limit is set on a plan or as a per-workspace override,
                  with 80%/100% owner alerts and graceful per-channel
                  pausing (not a hard cutoff on inbound voice) once a cap is
                  hit.
                </p>
              </div>

              <div className="feature">
                <div className="feature-head">
                  <h3>Agency branding &amp; settings</h3>
                </div>
                <p>
                  White-labels the deployment: agency name and logo, mobile
                  home-screen icon, dashboard accent color, shared-sender
                  fall-backs, the deployment&apos;s default AI model, and
                  the Agency Assistant&apos;s master switch.
                </p>
              </div>

              <div className="feature">
                <div className="feature-head">
                  <h3>Get started / guided setup</h3>
                </div>
                <p>
                  Owner orientation page plus an optional in-app form for
                  entering the remaining API keys directly, showing each as
                  not-set / saved / active and triggering a redeploy.
                </p>
              </div>
            </section>

            <section className="group" id="platform">
              <div className="group-head">
                <h2>Account &amp; Platform</h2>
                <span className="group-count">2 features</span>
              </div>
              <p className="group-note">
                The layer under everyone&apos;s login, agency owner or
                collaborator alike.
              </p>

              <div className="feature">
                <div className="feature-head">
                  <h3>Your account</h3>
                </div>
                <p>
                  Profile and avatar, light/dark/system appearance, password
                  change, and per-device push-notification preferences,
                  plus the workspace switcher and global search.
                </p>
              </div>

              <div className="feature">
                <div className="feature-head">
                  <h3>Mobile app &amp; push notifications</h3>
                </div>
                <p>
                  Home-screen install (PWA) on custom-branded deployments,
                  with per-user, per-device push alerts for new leads,
                  inbound messages, bookings, missed calls, and
                  quote/invoice decisions.
                </p>
              </div>
            </section>

            <section className="group" id="developer">
              <div className="group-head">
                <h2>Developer &amp; Integrations</h2>
                <span className="group-count">2 features</span>
              </div>
              <p className="group-note">
                The way LeadStack talks to everything that isn&apos;t
                LeadStack.
              </p>

              <div className="feature">
                <div className="feature-head">
                  <h3>Public API &amp; outbound webhooks</h3>
                  <span className="tag gate">Agency-gated</span>
                </div>
                <p>
                  REST API (lsk_live_ / lsk_test_ keys, per-key rate limits,
                  Idempotency-Key support) covering contacts, deals, tasks,
                  events, forms, and pipelines, plus outbound webhooks — one
                  per event category — signed Stripe-style with retries and
                  auto-pause after 10 straight failures. Quick-start recipes
                  give one-click keys and copy-paste Zapier/Make/n8n steps.
                </p>
              </div>

              <div className="feature">
                <div className="feature-head">
                  <h3>Templates</h3>
                </div>
                <p>
                  Reusable email and SMS bodies with merge tags, picked from
                  by Workflows and Broadcasts; every email template must
                  include the unsubscribe merge tag before it can send.
                </p>
              </div>
            </section>
          </main>
        </div>

        <footer className="note">
          Compiled from the in-app AI Suite knowledge base and product build
          history. Tags mark what isn&apos;t universally on:{" "}
          <span className="tag gate">Agency-gated</span> features are off
          until the agency owner enables them per client,{" "}
          <span className="tag beta">Beta</span> marks features still
          settling, and <span className="tag admin">Admin</span> marks an
          admin-only control.
        </footer>
      </div>
    </div>
  );
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap');

.feature-map-page{
  --bg:#F6F7F4;
  --surface:#FFFFFF;
  --ink:#161A17;
  --muted:#5C665F;
  --faint:#8B958E;
  --line:#DEE4DE;
  --accent:#2F6F5E;
  --accent-strong:#1F4F42;
  --accent-soft:#E3EEE9;
  --tag-beta-bg:#FBF0DC;
  --tag-beta-fg:#8A5C15;
  --tag-gate-bg:#EFEAF7;
  --tag-gate-fg:#5C4C8A;
  --tag-admin-bg:#E7EEF7;
  --tag-admin-fg:#375580;
  background:var(--bg);
  color:var(--ink);
  font-family:'IBM Plex Sans', system-ui, sans-serif;
  font-size:15.5px;
  line-height:1.55;
  padding-inline:20px;
  -webkit-font-smoothing:antialiased;
  min-height:100vh;
}
@media (prefers-color-scheme: dark){
  .feature-map-page{
    --bg:#12150F;
    --surface:#191D18;
    --ink:#ECF0EA;
    --muted:#9CA89E;
    --faint:#6D766F;
    --line:#2B322B;
    --accent:#5FBB9F;
    --accent-strong:#8AD4BB;
    --accent-soft:#1D2A24;
    --tag-beta-bg:#332A15;
    --tag-beta-fg:#E3B45B;
    --tag-gate-bg:#28223A;
    --tag-gate-fg:#C4B4EA;
    --tag-admin-bg:#1D2732;
    --tag-admin-fg:#A9C4E8;
  }
}
html.dark .feature-map-page{
  --bg:#12150F;
  --surface:#191D18;
  --ink:#ECF0EA;
  --muted:#9CA89E;
  --faint:#6D766F;
  --line:#2B322B;
  --accent:#5FBB9F;
  --accent-strong:#8AD4BB;
  --accent-soft:#1D2A24;
  --tag-beta-bg:#332A15;
  --tag-beta-fg:#E3B45B;
  --tag-gate-bg:#28223A;
  --tag-gate-fg:#C4B4EA;
  --tag-admin-bg:#1D2732;
  --tag-admin-fg:#A9C4E8;
}

.feature-map-page *{box-sizing:border-box;}
.feature-map-page h1,
.feature-map-page h2,
.feature-map-page h3{
  font-family:'Fraunces', Georgia, serif;
  text-wrap:balance;
  font-weight:600;
  letter-spacing:-0.01em;
}
.feature-map-page a{color:var(--accent-strong);}
.feature-map-page code,
.feature-map-page .mono{font-family:'IBM Plex Mono', ui-monospace, monospace;}

.feature-map-page .page{max-width:1180px;margin:0 auto;}

.feature-map-page header.hero{
  padding-block:56px 32px;
  border-bottom:1px solid var(--line);
  margin-bottom:8px;
}
.feature-map-page .eyebrow{
  font-family:'IBM Plex Mono', monospace;
  font-size:12px;
  letter-spacing:.12em;
  text-transform:uppercase;
  color:var(--accent-strong);
  margin:0 0 14px;
}
.feature-map-page h1.title{
  font-size:clamp(2rem, 4vw, 3rem);
  margin:0 0 14px;
  max-width:16ch;
}
.feature-map-page .dek{
  max-width:62ch;
  color:var(--muted);
  font-size:1.05rem;
  margin:0 0 22px;
}
.feature-map-page .stat-row{
  display:flex;
  flex-wrap:wrap;
  gap:28px;
  margin-top:8px;
}
.feature-map-page .stat{display:flex; flex-direction:column; gap:2px;}
.feature-map-page .stat .num{
  font-family:'IBM Plex Mono', monospace;
  font-size:1.5rem;
  font-weight:500;
  font-variant-numeric:tabular-nums;
  color:var(--ink);
}
.feature-map-page .stat .label{
  font-size:12px;
  color:var(--faint);
  text-transform:uppercase;
  letter-spacing:.06em;
}

.feature-map-page .layout{
  display:grid;
  grid-template-columns:220px minmax(0,1fr);
  gap:40px;
  align-items:start;
  padding-block:32px 80px;
}
.feature-map-page nav.toc{
  position:sticky;
  top:20px;
  display:flex;
  flex-direction:column;
  gap:2px;
  max-height:calc(100vh - 40px);
  overflow-y:auto;
}
.feature-map-page nav.toc a{
  text-decoration:none;
  color:var(--muted);
  font-size:13px;
  padding:6px 10px;
  border-radius:6px;
  border-left:2px solid transparent;
  display:flex;
  justify-content:space-between;
  gap:8px;
}
.feature-map-page nav.toc a:hover{ background:var(--accent-soft); color:var(--ink); }
.feature-map-page nav.toc a .n{ font-family:'IBM Plex Mono',monospace; color:var(--faint); font-size:11px; }

.feature-map-page main{min-width:0;}

.feature-map-page section.group{
  padding-block:34px;
  border-bottom:1px solid var(--line);
  scroll-margin-top:20px;
}
.feature-map-page section.group:first-child{padding-top:6px;}
.feature-map-page section.group:last-child{border-bottom:none;}

.feature-map-page .group-head{
  display:flex;
  align-items:baseline;
  gap:12px;
  flex-wrap:wrap;
  margin-bottom:6px;
}
.feature-map-page .group-head h2{
  font-size:1.5rem;
  margin:0;
}
.feature-map-page .group-count{
  font-family:'IBM Plex Mono', monospace;
  font-size:12px;
  color:var(--faint);
  background:var(--surface);
  border:1px solid var(--line);
  padding:2px 8px;
  border-radius:20px;
  white-space:nowrap;
}
.feature-map-page .group-note{
  color:var(--muted);
  max-width:70ch;
  margin:6px 0 22px;
}

.feature-map-page .feature{
  padding:16px 0;
  border-top:1px dashed var(--line);
}
.feature-map-page .feature:first-of-type{border-top:none; padding-top:4px;}
.feature-map-page .feature-head{
  display:flex;
  align-items:baseline;
  flex-wrap:wrap;
  gap:8px 10px;
  margin-bottom:5px;
}
.feature-map-page .feature-head h3{
  font-size:1.02rem;
  font-weight:600;
  margin:0;
  font-family:'IBM Plex Sans', sans-serif;
  letter-spacing:0;
}
.feature-map-page .feature p{
  margin:0 0 6px;
  color:var(--ink);
  max-width:72ch;
}
.feature-map-page .feature ul{
  margin:6px 0 0;
  padding-left:18px;
  max-width:72ch;
}
.feature-map-page .feature li{
  margin-bottom:4px;
  color:var(--ink);
}
.feature-map-page .feature li::marker{ color:var(--faint); }
.feature-map-page .feature .loc{
  color:var(--faint);
  font-size:12.5px;
  font-family:'IBM Plex Mono', monospace;
}

.feature-map-page .tag{
  font-family:'IBM Plex Mono', monospace;
  font-size:10.5px;
  letter-spacing:.03em;
  text-transform:uppercase;
  padding:2px 7px;
  border-radius:4px;
  white-space:nowrap;
}
.feature-map-page .tag.beta{background:var(--tag-beta-bg); color:var(--tag-beta-fg);}
.feature-map-page .tag.gate{background:var(--tag-gate-bg); color:var(--tag-gate-fg);}
.feature-map-page .tag.admin{background:var(--tag-admin-bg); color:var(--tag-admin-fg);}

.feature-map-page footer.note{
  max-width:70ch;
  color:var(--faint);
  font-size:13px;
  padding-block:0 60px;
}

@media (max-width: 860px){
  .feature-map-page .layout{ grid-template-columns:1fr; gap:0; }
  .feature-map-page nav.toc{
    position:sticky;
    top:0;
    z-index:5;
    flex-direction:row;
    overflow-x:auto;
    background:var(--bg);
    border-bottom:1px solid var(--line);
    padding-block:10px;
    max-height:none;
    margin-bottom:10px;
  }
  .feature-map-page nav.toc a{ flex:0 0 auto; border-left:none; border-bottom:2px solid transparent; border-radius:0; }
  .feature-map-page nav.toc a .n{display:none;}
}
`;
