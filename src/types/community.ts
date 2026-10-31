import type { Timestamp, FieldValue } from "firebase/firestore";

/**
 * Community + Courses (Skool-style). Available to every deployment, gated per
 * sub-account by `communityEnabledByAgency`.
 *
 * A {@link Member} is a login identity scoped to one sub-account; group
 * membership is a separate record, so an identity sees nothing until it joins.
 * Members are not Firebase Auth users: they use magic-link + HMAC session
 * cookies (lib/community/member-auth.ts) and can never reach `/sa/*`.
 */

export type MemberStatus = "active" | "removed";

/** `subAccounts/{saId}/members/{memberId}`. One login spans every group in the sub-account. */
export interface Member {
  id: string;
  subAccountId: string;
  agencyId: string;
  /** Trimmed + lowercased. Unique per sub-account. */
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  bio: string;
  /** Joining doubles as lead capture. Null only if reconciliation failed. */
  contactId: string | null;
  status: MemberStatus;
  createdAt: Timestamp | FieldValue | null;
  updatedAt: Timestamp | FieldValue | null;
  /** Stamped on each session load; drives "online"/"last active". */
  lastSeenAt: Timestamp | FieldValue | null;
}

/**
 * One space (feed + classroom + leaderboard) at `/c/[saId]/[slug]`, stored at
 * `subAccounts/{saId}/communityGroups/{groupId}`.
 */
export type GroupAccess = "free" | "paid";
export type GroupJoinPolicy = "open" | "approval";
export type GroupStatus = "draft" | "published";
/**
 * `"courses"` hides feed/directory/leaderboards so the group presents as a
 * standalone course. Presentation only; reversible any time.
 */
export type GroupMode = "community" | "courses";

export interface CommunityGroup {
  id: string;
  subAccountId: string;
  agencyId: string;
  createdByUid: string;
  name: string;
  /** Unique within the sub-account. */
  slug: string;
  /** Rich text for the public landing page. */
  about: string;
  /** Up to 100 chars, under the logo in the join card. */
  tagline: string;
  coverUrl: string | null;
  /** Falls back to cover. */
  cardImageUrl: string | null;
  /** Falls back to cover. */
  logoUrl: string | null;
  /** Hex accent for the member surface. Null = neutral default. */
  brandColor: string | null;
  access: GroupAccess;
  /** One-time price when `access === "paid"`. */
  priceCents: number | null;
  currency: string | null;
  /** Read via `groupMode()`; undefined = "community". */
  mode?: GroupMode;
  /** YouTube/Vimeo URL; replaces the cover image as the sales-page hero. */
  salesVideoUrl?: string | null;
  salesVideoProvider?: VideoProvider | null;
  salesVideoId?: string | null;
  joinPolicy: GroupJoinPolicy;
  pointsEnabled: boolean;
  /** Always includes "General". */
  categories: string[];
  /** Shown in the feed right-rail. */
  links: ResourceLink[];
  status: GroupStatus;
  /** Denormalized active count, bumped on join/leave. */
  memberCount: number;
  createdAt: Timestamp | FieldValue | null;
  updatedAt: Timestamp | FieldValue | null;
}

/** `communityGroups/{groupId}/memberships/{memberId}` (doc id = memberId). */
export type GroupMembershipRole = "member" | "moderator";
export type GroupMembershipStatus =
  | "active"
  | "pending"
  | "removed"
  | "banned";

export interface GroupMembership {
  id: string;
  subAccountId: string;
  agencyId: string;
  groupId: string;
  memberId: string;
  role: GroupMembershipRole;
  status: GroupMembershipStatus;
  /** Per group; 1 like = 1 point. */
  points: number;
  /** 1-9, derived from points; stored for cheap leaderboard reads. */
  level: number;
  joinedAt: Timestamp | FieldValue | null;
}

/**
 * `communityGroups/{groupId}/posts/{postId}`. Likes are doc-per-liker in
 * `likes/{memberId}` (idempotent toggle); comments in `comments/`.
 */
export interface CommunityPost {
  id: string;
  subAccountId: string;
  agencyId: string;
  groupId: string;
  authorMemberId: string;
  title: string;
  body: string;
  category: string | null;
  pinned: boolean;
  likeCount: number;
  commentCount: number;
  createdAt: Timestamp | FieldValue | null;
  updatedAt: Timestamp | FieldValue | null;
}

export interface CommunityComment {
  id: string;
  groupId: string;
  postId: string;
  authorMemberId: string;
  body: string;
  likeCount: number;
  /** Top-level parent, or null. Threads are one level deep; replies to replies attach to the same parent. */
  parentId: string | null;
  createdAt: Timestamp | FieldValue | null;
}

/** Member identity + per-group level, hydrated for rendering. */
export interface AuthorView {
  memberId: string;
  displayName: string;
  avatarUrl: string | null;
  level: number;
}

export interface FeedPost extends CommunityPost {
  author: AuthorView;
  likedByViewer: boolean;
}

export interface FeedComment extends CommunityComment {
  author: AuthorView;
  likedByViewer: boolean;
}

// Direct messages

export interface DmMessageView {
  id: string;
  senderId: string;
  body: string;
  createdAtMs: number;
}
export interface DmMemberView {
  memberId: string;
  displayName: string;
  avatarUrl: string | null;
}
export interface DmInboxItem {
  threadId: string;
  other: DmMemberView;
  lastBody: string;
  lastAtMs: number | null;
  unread: boolean;
}

// Classroom

/**
 * `communityGroups/{groupId}/courses/{courseId}`. Sections and lessons are
 * subcollections; lessons are flat and carry a `sectionId`.
 */
export type CourseAccess = "open" | "level" | "purchase";

export interface Course {
  id: string;
  subAccountId: string;
  agencyId: string;
  groupId: string;
  title: string;
  description: string;
  thumbnailUrl: string | null;
  order: number;
  published: boolean;
  access: CourseAccess;
  /** When `access === "level"`. */
  requiredLevel: number | null;
  /** One-time price when `access === "purchase"`. */
  priceCents: number | null;
  currency: string | null;
  createdAt: Timestamp | FieldValue | null;
  updatedAt: Timestamp | FieldValue | null;
}

export interface CourseSection {
  id: string;
  title: string;
  order: number;
}

export type VideoProvider = "youtube" | "vimeo";

export interface ResourceLink {
  label: string;
  url: string;
}

export interface Lesson {
  id: string;
  sectionId: string | null;
  title: string;
  order: number;
  published: boolean;
  videoUrl: string | null;
  videoProvider: VideoProvider | null;
  videoId: string | null;
  bodyHtml: string;
  resourceLinks: ResourceLink[];
  createdAt: Timestamp | FieldValue | null;
  updatedAt: Timestamp | FieldValue | null;
}

/**
 * `courses/{courseId}/enrollments/{memberId}`. Completed lesson ids are an
 * array (bounded at 200/course) so progress is a single read.
 */
export interface Enrollment {
  id: string;
  memberId: string;
  courseId: string;
  status: "enrolled" | "completed";
  completedLessonIds: string[];
  progressPct: number;
  enrolledAt: Timestamp | FieldValue | null;
  completedAt: Timestamp | FieldValue | null;
}

/**
 * One-time PayPal purchase at `communityGroups/{groupId}/purchases/{id}`.
 * Reconciled manually (admin marks paid); a webhook could flip `status` instead.
 */
export type PurchaseScope = "group" | "course";
export type PurchaseStatus = "pending" | "paid" | "void";

export interface Purchase {
  id: string;
  subAccountId: string;
  agencyId: string;
  groupId: string;
  memberId: string;
  scope: PurchaseScope;
  /** groupId or courseId, per scope. */
  targetId: string;
  amountCents: number;
  currency: string;
  paypalUrl: string;
  status: PurchaseStatus;
  grantedByUid: string | null;
  requestedAt: Timestamp | FieldValue | null;
  paidAt: Timestamp | FieldValue | null;
  /** Set when access came with a product order rather than a community checkout. */
  orderId?: string;
}

export interface CourseCardView {
  id: string;
  title: string;
  description: string;
  thumbnailUrl: string | null;
  lessonCount: number;
  progressPct: number;
  /** Null when accessible. `purchasable` = a one-time purchase clears it (vs a level unlock). */
  locked: { reason: string; purchasable: boolean } | null;
  firstLessonId: string | null;
}
