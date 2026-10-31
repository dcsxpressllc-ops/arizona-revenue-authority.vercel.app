/**
 * Merge tags resolved at send time against the contact, sub-account and owner
 * snapshots. Unknown tags become "" so `{{...}}` never leaks into outbound copy.
 *
 *   {{contact.firstName}} {{contact.lastName}} {{contact.email}} {{contact.phone}}
 *   {{owner.firstName}} {{owner.email}} {{workspace.name}}
 *   {{bookingLink}}      sub-account's booking URL, "" when unset
 *   {{unsubscribeLink}}  required in email bodies
 *
 * Slugged booking tags ({{bookingLink:30min}}) are reserved, not supported.
 */

export interface MergeTagSubject {
  contact: {
    name: string;
    email: string;
    phone: string;
  };
  owner: {
    displayName: string;
    email: string;
  };
  workspace: {
    name: string;
  };
  /** "" when the sub-account has no booking URL. */
  bookingLink: string;
  /** Fully-qualified URL. "" for SMS templates. */
  unsubscribeLink: string;
}

const TAG_RE = /\{\{\s*([a-zA-Z0-9_.:-]+)\s*\}\}/g;

function firstWord(s: string | null | undefined): string {
  if (!s) return "";
  const trimmed = s.trim();
  const space = trimmed.indexOf(" ");
  return space === -1 ? trimmed : trimmed.slice(0, space);
}

function lastWord(s: string | null | undefined): string {
  if (!s) return "";
  const trimmed = s.trim();
  const space = trimmed.lastIndexOf(" ");
  return space === -1 ? "" : trimmed.slice(space + 1);
}

export function resolveMergeTags(
  body: string,
  subject: MergeTagSubject,
): string {
  return body.replace(TAG_RE, (_match, tag: string) => {
    switch (tag) {
      case "contact.firstName":
        return firstWord(subject.contact.name);
      case "contact.lastName":
        return lastWord(subject.contact.name);
      case "contact.email":
        return subject.contact.email ?? "";
      case "contact.phone":
        return subject.contact.phone ?? "";
      case "owner.firstName":
        return firstWord(subject.owner.displayName);
      case "owner.email":
        return subject.owner.email ?? "";
      case "workspace.name":
        return subject.workspace.name ?? "";
      case "bookingLink":
        return subject.bookingLink ?? "";
      case "unsubscribeLink":
        return subject.unsubscribeLink ?? "";
      default:
        // Unknown or reserved tags (e.g. bookingLink:30min) resolve to "".
        return "";
    }
  });
}

/** Tags offered in the template editor's Insert picker. */
export const SUPPORTED_TAGS_EMAIL: ReadonlyArray<{ tag: string; description: string }> = [
  { tag: "contact.firstName", description: "Contact's first name" },
  { tag: "contact.lastName", description: "Contact's last name" },
  { tag: "contact.email", description: "Contact's email address" },
  { tag: "contact.phone", description: "Contact's phone number" },
  { tag: "owner.firstName", description: "Agency owner's first name" },
  { tag: "owner.email", description: "Agency owner's email" },
  { tag: "workspace.name", description: "Sub-account name" },
  { tag: "bookingLink", description: "Booking page URL (set under Booking → Default booking link)" },
  { tag: "unsubscribeLink", description: "Per-contact unsubscribe URL (required in email)" },
];

export const SUPPORTED_TAGS_SMS: ReadonlyArray<{ tag: string; description: string }> = [
  { tag: "contact.firstName", description: "Contact's first name" },
  { tag: "contact.lastName", description: "Contact's last name" },
  { tag: "owner.firstName", description: "Agency owner's first name" },
  { tag: "workspace.name", description: "Sub-account name" },
  { tag: "bookingLink", description: "Booking page URL (set under Booking → Default booking link)" },
];

/** null if valid. Email bodies must contain {{unsubscribeLink}}. */
export function validateEmailBody(body: string): string | null {
  if (!body.includes("{{unsubscribeLink}}")) {
    return "Email body must include {{unsubscribeLink}} somewhere.";
  }
  return null;
}

/**
 * Reject slugged booking tags like {{bookingLink:30min}}. Plain {{bookingLink}}
 * is fine; the slugged form is reserved, and erroring beats silently sending "".
 */
export function validateNoBookingTags(body: string): string | null {
  const matches = body.match(/\{\{\s*bookingLink:[a-z0-9-]+\s*\}\}/g);
  if (matches && matches.length > 0) {
    return `Slugged booking tags aren't supported yet: ${matches.join(", ")}. Use {{bookingLink}} for the sub-account's default booking URL.`;
  }
  return null;
}
