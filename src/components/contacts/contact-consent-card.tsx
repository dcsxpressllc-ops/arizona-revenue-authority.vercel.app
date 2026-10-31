"use client";

import { useState } from "react";
import {
  ChevronDown,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
} from "lucide-react";
import { formatContactDate } from "@/lib/format";
import type { Contact } from "@/types/contacts";

/**
 * Read-only SMS consent, from the record the submit route captures (wording,
 * time, source URL, IP). States in precedence order:
 *  - Carrier STOP: only an inbound START lifts it, never in-app.
 *  - Declined: said no on a form's consent box. Our own block, lifted if they consent later.
 *  - Consented: proof expandable below.
 *  - Never asked: imports, manual entry, forms without a consent box.
 */
export function ContactConsentCard({ contact }: { contact: Contact }) {
  const [proofOpen, setProofOpen] = useState(false);
  const consent = contact.smsConsent ?? null;

  let icon: React.ReactNode;
  let title: string;
  let detail: string;
  if (contact.smsOptedOut) {
    icon = <ShieldAlert className="h-3.5 w-3.5 text-rose-500" />;
    title = "Opted out (carrier STOP)";
    detail =
      "This number texted STOP. No SMS will be sent. Only the customer texting START lifts this — it can't be cleared here.";
  } else if (consent && consent.consented === false) {
    icon = <ShieldAlert className="h-3.5 w-3.5 text-amber-500" />;
    title = "SMS consent declined";
    detail =
      "Asked on a form and declined. No SMS will be sent. Lifts if they consent on a future submission.";
  } else if (consent && consent.consented === true) {
    icon = <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />;
    title = "SMS consent given";
    detail = "Opted in via a form consent box. Proof of consent below.";
  } else {
    icon = <ShieldQuestion className="h-3.5 w-3.5 text-muted-foreground" />;
    title = "Never asked";
    detail =
      "No consent record (imported, manually added, or captured without a consent box). Sendable — but no proof of opt-in is on file.";
  }

  // Email deliverability sits alongside SMS consent: both decide whether an
  // automated send goes out.
  let emailIcon: React.ReactNode;
  let emailTitle: string;
  let emailDetail: string;
  if (contact.emailOptedOut) {
    emailIcon = <ShieldAlert className="h-3.5 w-3.5 text-rose-500" />;
    emailTitle = "Opted out of email";
    emailDetail =
      "Unsubscribed (or marked a message as spam). No broadcasts or workflow emails will be sent.";
  } else if (contact.emailBouncedAt) {
    emailIcon = <ShieldAlert className="h-3.5 w-3.5 text-amber-500" />;
    emailTitle = "Email bounced";
    emailDetail = `A broadcast to this address hard-bounced on ${formatContactDate(contact.emailBouncedAt)}. Broadcasts skip this contact until you change their email address.`;
  } else {
    emailIcon = <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />;
    emailTitle = "Email deliverable";
    emailDetail = "No unsubscribe, complaint or bounce on file.";
  }

  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="mb-1 flex items-center gap-2">
        {emailIcon}
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Email
        </p>
      </div>
      <p className="text-sm font-medium">{emailTitle}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{emailDetail}</p>

      <div className="mb-1 mt-4 flex items-center gap-2">
        {icon}
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          SMS consent
        </p>
      </div>
      <p className="text-sm font-medium">{title}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>

      {consent && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setProofOpen((v) => !v)}
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            aria-expanded={proofOpen}
          >
            <ChevronDown
              className={`h-3 w-3 transition-transform ${proofOpen ? "rotate-180" : ""}`}
            />
            {proofOpen ? "Hide consent record" : "View consent record"}
          </button>
          {proofOpen && (
            <dl className="mt-2 space-y-1.5 rounded-lg border bg-background p-3 text-xs">
              <div>
                <dt className="font-medium text-muted-foreground">
                  Wording shown
                </dt>
                <dd className="mt-0.5 italic">
                  &ldquo;{consent.textShown}&rdquo;
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">When</dt>
                <dd>
                  {consent.consentedAt
                    ? formatContactDate(consent.consentedAt)
                    : "—"}
                </dd>
              </div>
              {consent.sourceUrl && (
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Page</dt>
                  <dd className="min-w-0 truncate" title={consent.sourceUrl}>
                    {consent.sourceUrl}
                  </dd>
                </div>
              )}
            </dl>
          )}
        </div>
      )}
    </div>
  );
}
