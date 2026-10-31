/**
 * Connection to a self-hosted Webinar1 deployment. API calls are proxied through
 * /api/sub-accounts/{id}/webinar1/*; its signed webhooks land at
 * /api/webhooks/webinar1/sa/{subAccountId}.
 *
 * The API key and signing secret live in private/ (Admin SDK only). Only display
 * metadata goes on the sub-account doc, which every member can read.
 */

export const WEBINAR1_CONNECTION_DOC_ID = "webinar1Connection";

export function webinar1ConnectionSecretPath(subAccountId: string): string {
  return `subAccounts/${subAccountId}/private/${WEBINAR1_CONNECTION_DOC_ID}`;
}

/** Server only. Never return this from an API route. */
export interface Webinar1ConnectionSecret {
  /** Origin, no trailing slash. */
  baseUrl: string;
  /** wbk_... key from Webinar1 Settings > API. */
  apiKey: string;
  /** whsec_... for our endpoint on the Webinar1 side. Empty until pasted manually if auto-registration failed. */
  webhookSecret: string;
  /** Deleted on disconnect. */
  webhookEndpointId: string | null;
}

/** SubAccountDoc.webinar1ConnectionMeta. No secrets. */
export interface Webinar1ConnectionMeta {
  baseUrl: string;
  /** Start of the key, so admins can tell which one is stored. */
  keyPrefix: string;
  /** false until the signing secret is in place. */
  webhookReady: boolean;
  connectedAt: Date;
}

/** Wire shapes from Webinar1's /api/launchcast/v1. */
export interface Webinar1Video {
  id: string;
  title: string;
  status: string;
  durationSeconds: number;
  thumbnailUrl: string | null;
  createdAt: string | null;
}

export interface Webinar1Webinar {
  id: string;
  title: string;
  slug: string;
  /** Public registration page. */
  url: string;
  isActive: boolean;
  scheduleMode: string;
  videoId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** The only events the CRM cares about. */
export const WEBINAR1_SUBSCRIBED_EVENTS = [
  "registration.created",
  "attendee.joined",
  "attendee.completed",
  "cta.clicked",
] as const;
