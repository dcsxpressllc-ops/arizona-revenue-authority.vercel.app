import "server-only";

import webpush from "web-push";
import { getAdminDb } from "@/lib/firebase/admin";
import { pushIsConfigured, getVapidKeys } from "@/lib/push/config";
import { CUSTOM_BRAND } from "@/config/landing";
import { GLOBAL_TERRITORY_ID } from "@/types/tenancy";
import type {
  AgencyDoc,
  SubAccountDoc,
  SubAccountMemberDoc,
} from "@/types";

/**
 * Fans a push out to everyone who should hear about a sub-account event.
 * Callers `void` it; failures are warned and swallowed so nothing blocks the
 * originating write (some callers are provider webhooks that must 200 fast).
 *
 * Recipients:
 *   1. Active sub-account members: on by default, prefs can mute a sub-account.
 *   2. The agency owner (if not a member): opt-in only (pref exactly true),
 *      or they'd be buzzed for every event in every client account.
 *   3. With territory scoping on, collaborators only get events for their
 *      territories, mirroring the read rules so a push can't leak a lead.
 *
 * Membership is re-checked at send time, so removed members stop getting
 * pushes even if their device subscriptions remain.
 */

export interface SendPushInput {
  subAccountId: string;
  agencyId: string;
  title: string;
  body: string;
  /** App-relative deep link, e.g. /sa/abc/contacts/xyz */
  url: string;
  /** Same tag replaces the previous notification. */
  tag?: string;
  territoryId?: string | null;
}

interface Recipient {
  uid: string;
  role: string;
  assignedTerritoryIds: string[];
  /** Pref must be exactly true (agency owner). */
  optInOnly: boolean;
}

/** Push to one user's devices only, ignoring workspace notification prefs. Never throws. */
export async function sendPushToUser(input: {
  uid: string;
  title: string;
  body: string;
  url: string;
  tag?: string;
}): Promise<void> {
  try {
    if (!pushIsConfigured()) return;
    const { publicKey, privateKey } = getVapidKeys();
    const subject = `mailto:${CUSTOM_BRAND.supportEmail}`;
    const payload = JSON.stringify({
      title: input.title,
      body: input.body,
      url: input.url,
      tag: input.tag,
    });
    const subsSnap = await getAdminDb()
      .collection(`users/${input.uid}/pushSubscriptions`)
      .get();
    await Promise.all(
      subsSnap.docs.map(async (subDoc) => {
        const sub = subDoc.data();
        try {
          await webpush.sendNotification(
            {
              endpoint: sub.endpoint as string,
              keys: sub.keys as { p256dh: string; auth: string },
            },
            payload,
            { vapidDetails: { subject, publicKey, privateKey } },
          );
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            await subDoc.ref.delete().catch(() => {});
          } else {
            console.warn(`[push/send] delivery failed for ${input.uid}`, err);
          }
        }
      }),
    );
  } catch (err) {
    console.warn("[push/send] sendPushToUser failed", err);
  }
}

export async function sendPushForEvent(input: SendPushInput): Promise<void> {
  try {
    if (!pushIsConfigured()) return;
    const db = getAdminDb();

    const [saSnap, agencySnap, membersSnap] = await Promise.all([
      db.doc(`subAccounts/${input.subAccountId}`).get(),
      db.doc(`agencies/${input.agencyId}`).get(),
      db.collection(`subAccounts/${input.subAccountId}/subAccountMembers`).get(),
    ]);
    if (!saSnap.exists) return;
    const subAccount = saSnap.data() as SubAccountDoc;
    const agency = agencySnap.exists ? (agencySnap.data() as AgencyDoc) : null;

    const recipients = new Map<string, Recipient>();
    for (const doc of membersSnap.docs) {
      const m = doc.data() as SubAccountMemberDoc;
      if (m.status !== "active") continue;
      recipients.set(doc.id, {
        uid: doc.id,
        role: m.role,
        assignedTerritoryIds: m.assignedTerritoryIds ?? [],
        optInOnly: false,
      });
    }
    if (agency?.ownerUid && !recipients.has(agency.ownerUid)) {
      recipients.set(agency.ownerUid, {
        uid: agency.ownerUid,
        role: "agencyOwner",
        assignedTerritoryIds: [],
        optInOnly: true,
      });
    }
    if (recipients.size === 0) return;

    // Admins/owner always pass; Global or untagged events pass for everyone,
    // matching the read rules.
    const scopingOn = subAccount.territoryScopingEnabled === true;
    const territoryId = input.territoryId ?? null;
    const territoryApplies =
      scopingOn && !!territoryId && territoryId !== GLOBAL_TERRITORY_ID;

    const eligible = [...recipients.values()].filter((r) => {
      if (!territoryApplies) return true;
      // Only collaborators are territory-scoped.
      if (r.role !== "collaborator") return true;
      return r.assignedTerritoryIds.includes(territoryId!);
    });
    if (eligible.length === 0) return;

    const { publicKey, privateKey } = getVapidKeys();
    const subject = `mailto:${CUSTOM_BRAND.supportEmail}`;
    const payload = JSON.stringify({
      title: input.title,
      body: input.body,
      url: input.url,
      tag: input.tag,
    });

    await Promise.all(
      eligible.map(async (recipient) => {
        try {
          const prefsSnap = await db
            .doc(`users/${recipient.uid}/settings/notifications`)
            .get();
          const prefs =
            (prefsSnap.data()?.subAccounts as
              | Record<string, boolean>
              | undefined) ?? {};
          const pref = prefs[input.subAccountId];
          const enabled = recipient.optInOnly ? pref === true : pref !== false;
          if (!enabled) return;

          const subsSnap = await db
            .collection(`users/${recipient.uid}/pushSubscriptions`)
            .get();
          await Promise.all(
            subsSnap.docs.map(async (subDoc) => {
              const sub = subDoc.data();
              try {
                await webpush.sendNotification(
                  {
                    endpoint: sub.endpoint as string,
                    keys: sub.keys as { p256dh: string; auth: string },
                  },
                  payload,
                  { vapidDetails: { subject, publicKey, privateKey } },
                );
              } catch (err) {
                const status = (err as { statusCode?: number }).statusCode;
                // 404/410: browser dropped the subscription (uninstall, permission revoked). Prune it.
                if (status === 404 || status === 410) {
                  await subDoc.ref.delete().catch(() => {});
                } else {
                  console.warn(
                    `[push/send] delivery failed for ${recipient.uid}`,
                    err,
                  );
                }
              }
            }),
          );
        } catch (err) {
          console.warn(`[push/send] recipient ${recipient.uid} failed`, err);
        }
      }),
    );
  } catch (err) {
    console.warn("[push/send] sendPushForEvent failed", err);
  }
}
