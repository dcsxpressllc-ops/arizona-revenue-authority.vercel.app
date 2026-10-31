import type { Timestamp, FieldValue } from "firebase/firestore";

/**
 * Operator-defined fields on contacts and deals. Definitions live at
 * subAccounts/{id}/customFields (member-read, server-write). Values are stored
 * inline on each contact/deal as customFields[key] so reads need no join.
 */

export type CustomFieldEntity = "contact" | "deal";

/** Mirrors GoHighLevel's common field types. */
export type CustomFieldType =
  | "text"
  | "number"
  | "date"
  | "dropdown"
  | "multiselect"
  | "checkbox"
  | "url"
  | "phone"
  | "email";

/** string for text/url/phone/email/date (ISO yyyy-mm-dd) and dropdown, number,
 *  boolean for checkbox, string[] for multiselect. null = unset. */
export type CustomFieldValue = string | number | boolean | string[] | null;

export interface CustomFieldDef {
  id: string;
  entity: CustomFieldEntity;
  /** snake_case map key under customFields, unique per sub-account + entity. Immutable. */
  key: string;
  label: string;
  type: CustomFieldType;
  /** Empty for types other than dropdown/multiselect. */
  options: string[];
  required: boolean;
  order: number;

  agencyId: string;
  subAccountId: string;
  createdByUid: string;
  createdAt: Timestamp | FieldValue | null;
  updatedAt: Timestamp | FieldValue | null;
}

export type CustomFieldDefInput = {
  entity: CustomFieldEntity;
  label: string;
  type: CustomFieldType;
  options?: string[];
  required?: boolean;
  order?: number;
};

export const CUSTOM_FIELD_OPTION_TYPES: ReadonlySet<CustomFieldType> = new Set([
  "dropdown",
  "multiselect",
]);

export const CUSTOM_FIELD_TYPE_LABELS: Record<CustomFieldType, string> = {
  text: "Text",
  number: "Number",
  date: "Date",
  dropdown: "Dropdown (single select)",
  multiselect: "Multi-select",
  checkbox: "Checkbox",
  url: "URL",
  phone: "Phone",
  email: "Email",
};

/** Per entity per sub-account. Bounded because values are stored inline on the doc. */
export const MAX_CUSTOM_FIELDS_PER_ENTITY = 50;
