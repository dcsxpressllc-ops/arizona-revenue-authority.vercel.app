import type { Timestamp, FieldValue } from "firebase/firestore";
import type { PipelineStageId } from "@/types/deals";

export type FormFieldType =
  | "text"
  | "email"
  | "phone"
  | "company"
  | "textarea"
  | "select"
  // A2P 10DLC opt-in checkbox. Checked: consent is logged on the contact and
  // smsOptedOut cleared. Present but unchecked: contact is created opted out.
  // Forms without this field keep the default behaviour.
  | "sms_consent";

export interface FormField {
  id: string;
  type: FormFieldType;
  label: string;
  placeholder: string;
  required: boolean;
  options: string[];
  // Contact field this value is written to.
  mapsTo: "name" | "email" | "phone" | "company" | "notes" | null;
  /**
   * sms_consent only. Stored verbatim as proof of consent, so it must keep the CTIA
   * elements: sender, frequency, "message & data rates may apply", STOP/HELP.
   */
  consentText?: string;
}

/** CTIA-compliant default. Carriers also expect Privacy/Terms links on the page. */
export function defaultSmsConsentText(businessName?: string): string {
  const biz = (businessName && businessName.trim()) || "us";
  return `By checking this box, you agree to receive SMS messages from ${biz}. Message frequency varies. Message and data rates may apply. Reply STOP to opt out, HELP for help.`;
}

/** Public form styling. URL params override the saved values. */
export interface FormAppearance {
  theme: "light" | "dark";
  /** Hex with leading #. */
  accent: string;
  /** Hides the header and "Powered by" footer. */
  hideChrome: boolean;
  /** Hides the form name and tagline, for host pages with their own heading. */
  hideTitle: boolean;
}

export interface FormSettings {
  pipelineStageId: PipelineStageId | null;
  autoTags: string[];
  thankYouMessage: string;
  redirectUrl: string;
  createDeal: boolean;
  dealTitleTemplate: string;
  dealValue: number;
  dealCurrency: string;
  appearance: FormAppearance;
}

export interface LeadForm {
  id: string;
  name: string;
  slug: string;
  fields: FormField[];
  settings: FormSettings;
  agencyId: string;
  subAccountId: string;
  createdByUid: string;
  enabled: boolean;
  submissionCount: number;
  createdAt: Timestamp | FieldValue | null;
  updatedAt: Timestamp | FieldValue | null;
}

export interface FormSubmission {
  id: string;
  formId: string;
  values: Record<string, string>;
  contactId: string | null;
  dealId: string | null;
  createdAt: Timestamp | FieldValue | null;
}

export type FormTemplate = "blank" | "contact";

export function defaultFormFields(): FormField[] {
  return [
    {
      id: "name",
      type: "text",
      label: "Full name",
      placeholder: "Jane Doe",
      required: true,
      options: [],
      mapsTo: "name",
    },
    {
      id: "email",
      type: "email",
      label: "Email",
      placeholder: "jane@example.com",
      required: true,
      options: [],
      mapsTo: "email",
    },
    {
      id: "phone",
      type: "phone",
      label: "Phone",
      placeholder: "+1 555 000 0000",
      required: false,
      options: [],
      mapsTo: "phone",
    },
    {
      id: "company",
      type: "company",
      label: "Company",
      placeholder: "Acme Inc.",
      required: false,
      options: [],
      mapsTo: "company",
    },
  ];
}

/** No Company field; the message maps to notes so it shows on the contact. */
export function contactFormFields(): FormField[] {
  return [
    {
      id: "name",
      type: "text",
      label: "Full name",
      placeholder: "Jane Doe",
      required: true,
      options: [],
      mapsTo: "name",
    },
    {
      id: "email",
      type: "email",
      label: "Email",
      placeholder: "jane@example.com",
      required: true,
      options: [],
      mapsTo: "email",
    },
    {
      id: "phone",
      type: "phone",
      label: "Phone",
      placeholder: "+1 555 000 0000",
      required: false,
      options: [],
      mapsTo: "phone",
    },
    {
      id: "message",
      type: "textarea",
      label: "How can we help?",
      placeholder: "Tell us a bit about what you're looking for…",
      required: true,
      options: [],
      mapsTo: "notes",
    },
  ];
}

export function contactFormSettings(): FormSettings {
  return {
    ...defaultFormSettings(),
    thankYouMessage:
      "Thanks for reaching out — we'll get back to you shortly.",
    autoTags: ["form", "contact"],
  };
}

export function defaultFormSettings(): FormSettings {
  return {
    pipelineStageId: "new",
    autoTags: ["form"],
    thankYouMessage: "Thanks — we'll be in touch shortly.",
    redirectUrl: "",
    createDeal: false,
    dealTitleTemplate: "New lead — {name}",
    dealValue: 0,
    dealCurrency: "USD",
    appearance: defaultFormAppearance(),
  };
}

export function defaultFormAppearance(): FormAppearance {
  return {
    theme: "light",
    accent: "#7c3aed",
    hideChrome: false,
    hideTitle: false,
  };
}
