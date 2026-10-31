import type { Timestamp } from "firebase/firestore";

/**
 * Google Calendar sync, per member. Status lives on the member-readable
 * calendarConnections/{uid} doc; OAuth tokens live in private/gcal-{uid}
 * (Admin SDK only). Never copy a token onto the connection doc.
 */

export type CalendarConnectionStatus = "connected" | "error";

/** What a member shares from their Google Calendar. Absent = off. */
export type CalendarImportMode = "off" | "busy" | "details";

export interface CalendarConnectionDoc {
  uid: string;
  /** Google only for now; leaves room for Outlook in the same collection. */
  provider: "google";
  /** Display only. */
  googleEmail: string | null;
  /** "error" means the refresh token was revoked or expired. Booking fails open to internal-only slots until reconnect. */
  status: CalendarConnectionStatus;
  /** e.g. "reconnect_required". */
  errorReason: string | null;
  connectedAt: Timestamp | Date | null;
  /** Last successful free/busy query. */
  lastSyncAt: Timestamp | Date | null;
  updatedAt: Timestamp | Date | null;
  /** Set only by the member themself; admins can't change it. */
  importMode?: CalendarImportMode;
  importStatus?: "ok" | "error" | null;
  importError?: string | null;
  importLastSyncAt?: Timestamp | Date | null;
  importedCount?: number | null;
  /** Last full-window reconcile (first sync, mode change, nightly). */
  importLastFullSyncAt?: Timestamp | Date | null;
  /** Last pass started; orders the sweep so a pass that dies doesn't hog it. */
  importLastAttemptAt?: Timestamp | Date | null;
  /** Bumped by every mode change; a running sync that sees it change backs off. */
  importGeneration?: number;
  /** Set once a full pass has replaced docs that used the old, workspace-less id. */
  importIdsScoped?: boolean;
}

/** Admin SDK only (covered by the deny-all `private/{docId}` rule). Written by
 *  the OAuth callback; read and refresh only through lib/google/calendar.ts. */
export interface GoogleCalendarPrivateDoc {
  refreshToken: string;
  /** Cached, ~1h. Null until first refresh. */
  accessToken: string | null;
  /** Epoch ms. Refreshed within 60s of expiry. */
  accessTokenExpiresAt: number | null;
  googleEmail: string | null;
  /** Always "primary" for now. */
  calendarId: string;
  /** What Google actually granted, which can be less than requested. */
  grantedScopes: string[];
  connectedAt: Timestamp | Date;
}

/** From Google free/busy. No titles. */
export interface ExternalBusyInterval {
  startAt: Date;
  endAt: Date;
}
