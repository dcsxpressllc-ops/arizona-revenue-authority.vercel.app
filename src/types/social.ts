import type { Timestamp, FieldValue } from "firebase/firestore";

/**
 * Scheduled posts to the sub-account's Facebook Page / Instagram account, using
 * the existing metaConfig connection. Top-level socialPosts, server-write only.
 * Publishing is a QStash callback at scheduledAt. Unused unless
 * socialPlannerEnabledByAgency is on and a Page is connected.
 */

export type SocialPlatform = "facebook" | "instagram";

/**
 * "publishing" is claimed in a transaction by the callback so a post can't
 * publish twice. "failed" means at least one target failed.
 */
export type SocialPostStatus =
  | "draft"
  | "scheduled"
  | "publishing"
  | "published"
  | "failed";

export interface SocialPostTargetResult {
  platform: SocialPlatform;
  status: "pending" | "published" | "failed";
  /** FB post id or IG media id. */
  externalId: string | null;
  error: string | null;
}

export interface SocialPostDoc {
  id: string;
  agencyId: string;
  subAccountId: string;
  createdByUid: string;

  /** Same caption for every target. */
  caption: string;
  /** Public https URL. Required for Instagram, whose publishing API only takes URLs. */
  imageUrl: string | null;
  /** Non-empty when scheduled. */
  targets: SocialPlatform[];

  status: SocialPostStatus;
  /** Null for drafts. */
  scheduledAt: Timestamp | FieldValue | null;
  /** Set when the callback finishes, success or not. */
  publishedAt: Timestamp | FieldValue | null;

  /** One per target. */
  results: SocialPostTargetResult[];
  qstashMessageId: string | null;

  createdAt: Timestamp | FieldValue | null;
  updatedAt: Timestamp | FieldValue | null;
}

export const SOCIAL_CAPTION_MAX = 5000;
