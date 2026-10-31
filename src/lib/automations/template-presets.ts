/**
 * Default templates for new sub-accounts. Shared by the server seeder
 * (seed-templates.ts) and the "Start from a preset" chips on the New Template
 * page, so edit them here rather than copying into either.
 */

import type { StepChannel } from "@/types/automations";

export interface TemplatePreset {
  /** React key for the chip. Not persisted. */
  id: string;
  /** Chip label; becomes the doc's `name`. */
  label: string;
  /** Tooltip text. */
  description: string;
  type: StepChannel;
  /** Email only. "" for SMS, where the doc's `subject` is null. */
  subject: string;
  body: string;
}

export const TEMPLATE_PRESETS: ReadonlyArray<TemplatePreset> = [
  {
    id: "welcome-email",
    label: "Welcome email",
    description: "Polite thanks-and-confirmation after a form submit.",
    type: "email",
    subject: "Thanks for getting in touch, {{contact.firstName}}",
    body: `Hi {{contact.firstName}},

Thanks for reaching out to {{workspace.name}} — your message landed and we'll be in touch within 24 hours.

If anything's urgent in the meantime, just reply to this email.

Cheers,
{{owner.firstName}}

—
Don't want emails like this? {{unsubscribeLink}}`,
  },
  {
    id: "welcome-sms",
    label: "Welcome SMS",
    description: "Short reply that sets expectations.",
    type: "sms",
    subject: "",
    body: "Hi {{contact.firstName}}, thanks for reaching out to {{workspace.name}} — we'll be in touch within 24 hours. Reply STOP to opt out.",
  },
  {
    id: "notify-owner-email",
    label: "Notify owner",
    description:
      "Internal email alert when a new lead comes in. Pair with Step 3 of Speed-to-Lead.",
    type: "email",
    subject: "New lead: {{contact.firstName}} {{contact.lastName}}",
    body: `A new lead just submitted a form on {{workspace.name}}.

Name:  {{contact.firstName}} {{contact.lastName}}
Email: {{contact.email}}
Phone: {{contact.phone}}

Reply to them directly at {{contact.email}}, or open the lead in your CRM.

—
{{unsubscribeLink}}`,
  },
];
