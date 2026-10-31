export type SubscriptionStatus =
  | "active"
  | "canceled"
  | "past_due"
  | "trialing"
  | "inactive";

export type Role = "admin" | "collaborator";

export type MemberStatus = "active" | "removed";

export interface UserDoc {
  uid: string;
  email: string;
  displayName: string;
  photoURL: string | null;
  // Legacy billing fields; real billing lives on AgencyDoc.
  stripeCustomerId: string | null;
  subscriptionStatus: SubscriptionStatus;
  subscriptionPriceId: string | null;
  // Legacy single-tenant role. Sub-account roles live on SubAccountMemberDoc.
  role: Role;
  status: MemberStatus;
  // Home agency the user was created under.
  primaryAgencyId: string | null;
  /** Owner dismissed the post-login setup snapshot dialog. Per user, not per
   *  device. Absent = show. Self-writable under the users/{uid} update rule. */
  setupSnapshotDismissed?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface AppConfig {
  // Legacy single-tenant fields.
  adminUid: string;
  adminEmail: string;
  // Set on first signup.
  firstAgencyId: string;
  firstAgencyOwnerUid: string;
  bootstrapEmail: string;
  createdAt: Date;
}

export interface InviteDoc {
  email: string;
  invitedByUid: string;
  createdAt: Date;
  acceptedByUid: string | null;
  acceptedAt: Date | null;
}
