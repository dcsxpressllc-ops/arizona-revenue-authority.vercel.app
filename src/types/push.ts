import type { Timestamp, FieldValue } from "firebase/firestore";

/**
 * Push subscriptions are per browser, at users/{uid}/pushSubscriptions/{sha256(endpoint)},
 * so re-subscribing overwrites the same row. Written by /api/push/subscriptions; users can read/delete their own.
 *
 * Prefs live at users/{uid}/settings/notifications as subAccountId -> enabled.
 * A missing key means ON for real members but OFF for an agency owner with no
 * membership row, otherwise the owner gets buzzed for every sub-account. Enforced in lib/push/send.ts.
 */

export interface PushSubscriptionDoc {
  id: string;
  uid: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** Rough device label for the settings device list. */
  userAgent: string | null;
  createdAt: Timestamp | FieldValue | null;
}

export interface NotificationPrefsDoc {
  subAccounts?: Record<string, boolean>;
  updatedAt?: Timestamp | FieldValue | null;
}
