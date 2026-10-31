import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { fireWorkflowTrigger } from "@/lib/workflows/engine";
import type {
  BroadcastSendDoc,
  EmailEventLookupDoc,
} from "@/types/broadcasts";

/**
 * Resend delivery events for tracked emails (broadcasts in v1). The event
 * carries the Resend email id; `emailEvents/{id}` says which send row it
 * belongs to. Each row counts a recipient once per outcome: first-time
 * stamps and the parent totals move inside one transaction, repeat opens and
 * clicks only bump the per-row counters, and retries are harmless.
 *
 * Side effects (timeline row, contact flags, workflow trigger) run only on
 * the first occurrence, outside the transaction.
 */

export const TRACKED_EMAIL_EVENTS = [
  "email.delivered",
  "email.opened",
  "email.clicked",
  "email.bounced",
  "email.complained",
] as const;
export type TrackedEmailEvent = (typeof TRACKED_EMAIL_EVENTS)[number];

export function isTrackedEmailEvent(type: unknown): type is TrackedEmailEvent {
  return (
    typeof type === "string" &&
    (TRACKED_EMAIL_EVENTS as readonly string[]).includes(type)
  );
}

export interface ResendDeliveryEvent {
  type: TrackedEmailEvent;
  created_at?: string;
  data?: {
    email_id?: string;
    subject?: string;
    click?: { link?: string };
    bounce?: { message?: string; type?: string; subType?: string };
  };
}

interface Outcome {
  first: boolean;
  send: BroadcastSendDoc | null;
}

/**
 * `/u/<token>` on this deployment. Matched by host when the app URL is known,
 * so a client site's own /u/ pages still count as clicks; path-only is the
 * fallback for a deployment with no app URL set.
 */
function isUnsubscribeLink(link: string): boolean {
  if (!link) return false;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return false;
  }
  if (!url.pathname.startsWith("/u/")) return false;
  const base = process.env.NEXT_PUBLIC_APP_URL;
  if (!base) return true;
  try {
    return new URL(base).host === url.host;
  } catch {
    return true;
  }
}

export async function handleResendDeliveryEvent(
  event: ResendDeliveryEvent,
): Promise<void> {
  const emailId = event.data?.email_id;
  // Resend ids are UUIDs; anything else can't be a doc id we wrote.
  if (!emailId || !/^[A-Za-z0-9_-]{1,128}$/.test(emailId)) return;
  const db = getAdminDb();
  const lookupSnap = await db.collection("emailEvents").doc(emailId).get();
  if (!lookupSnap.exists) return;
  const lookup = lookupSnap.data() as EmailEventLookupDoc;
  if (lookup.kind !== "broadcast") return;

  const broadcastRef = db.collection("broadcasts").doc(lookup.broadcastId);
  const sendRef = broadcastRef.collection("sends").doc(lookup.contactId);
  const link =
    event.type === "email.clicked"
      ? (event.data?.click?.link ?? "").slice(0, 500)
      : "";
  // With click tracking on, the unsubscribe link is rewritten too. Opting out
  // is not engagement: no stamps, no counters, no trigger.
  if (event.type === "email.clicked" && isUnsubscribeLink(link)) return;
  const bounceReason =
    event.type === "email.bounced"
      ? [event.data?.bounce?.type, event.data?.bounce?.subType, event.data?.bounce?.message]
          .filter(Boolean)
          .join(" · ")
          .slice(0, 300) || "bounced"
      : "";
  // Only a permanent bounce flags the contact; a full mailbox ("Transient") or
  // an ambiguous DSN ("Undetermined") would otherwise block every future
  // broadcast to them.
  const hardBounce =
    event.type === "email.bounced" &&
    (event.data?.bounce?.type ?? "").toLowerCase() === "permanent";

  let outcome: Outcome;
  try {
    outcome = await db.runTransaction(async (tx): Promise<Outcome> => {
      const snap = await tx.get(sendRef);
      if (!snap.exists) return { first: false, send: null };
      const send = snap.data() as BroadcastSendDoc;
      // Only rows Resend actually accepted carry events; a bounced row is final.
      if (send.status !== "sent") return { first: false, send };
      if (send.bouncedAt && event.type !== "email.bounced") {
        return { first: false, send };
      }

      switch (event.type) {
        case "email.delivered": {
          if (send.deliveredAt) return { first: false, send };
          tx.update(sendRef, { deliveredAt: FieldValue.serverTimestamp() });
          tx.update(broadcastRef, { "totals.delivered": FieldValue.increment(1) });
          return { first: true, send };
        }
        case "email.opened": {
          const first = !send.openedAt;
          tx.update(sendRef, {
            ...(first ? { openedAt: FieldValue.serverTimestamp() } : {}),
            opens: FieldValue.increment(1),
          });
          if (first) {
            tx.update(broadcastRef, { "totals.opened": FieldValue.increment(1) });
          }
          return { first, send };
        }
        case "email.clicked": {
          const first = !send.clickedAt;
          // A click proves an open even when the pixel was blocked.
          const impliedOpen = !send.openedAt;
          tx.update(sendRef, {
            ...(first ? { clickedAt: FieldValue.serverTimestamp() } : {}),
            ...(impliedOpen ? { openedAt: FieldValue.serverTimestamp() } : {}),
            clicks: FieldValue.increment(1),
          });
          const bump: Record<string, FieldValue> = {};
          if (first) bump["totals.clicked"] = FieldValue.increment(1);
          if (impliedOpen) bump["totals.opened"] = FieldValue.increment(1);
          if (Object.keys(bump).length > 0) tx.update(broadcastRef, bump);
          return { first, send };
        }
        case "email.bounced": {
          if (send.bouncedAt) return { first: false, send };
          tx.update(sendRef, {
            bouncedAt: FieldValue.serverTimestamp(),
            bounceReason,
          });
          tx.update(broadcastRef, { "totals.bounced": FieldValue.increment(1) });
          return { first: true, send };
        }
        case "email.complained": {
          if (send.complainedAt) return { first: false, send };
          tx.update(sendRef, { complainedAt: FieldValue.serverTimestamp() });
          tx.update(broadcastRef, { "totals.complained": FieldValue.increment(1) });
          return { first: true, send };
        }
      }
    });
  } catch (err) {
    console.error(`[email-events] ${event.type} txn failed for ${emailId}`, err);
    return;
  }

  if (!outcome.first || !outcome.send) return;
  const { send } = outcome;
  const contactRef = db.collection("contacts").doc(lookup.contactId);
  // update() rather than set+merge: a deleted contact must not come back as a
  // stub doc with no tenancy fields.
  const patchContact = (data: Record<string, unknown>) =>
    contactRef.update(data).catch(() => undefined);
  const broadcastSnap = await broadcastRef.get();
  const templateName =
    (broadcastSnap.data()?.templateName as string | undefined) ?? "broadcast";

  const activity = (
    type: "email_opened" | "email_clicked" | "email_bounced" | "email_complained",
    content: string,
    extra: Record<string, unknown> = {},
  ) =>
    contactRef
      .collection("activities")
      .add({
        type,
        content,
        createdBy: "broadcast",
        meta: { broadcastId: lookup.broadcastId, emailId, ...extra },
        agencyId: lookup.agencyId,
        subAccountId: lookup.subAccountId,
        createdAt: FieldValue.serverTimestamp(),
      })
      .catch((err) => console.warn("[email-events] activity write failed", err));

  switch (event.type) {
    case "email.delivered": {
      // Nothing beyond the row stamp: audiences already skip flagged contacts,
      // so a broadcast delivery can't be the thing that clears a bounce.
      return;
    }
    case "email.opened": {
      await activity("email_opened", `Opened bulk email: ${templateName}`);
      void fireWorkflowTrigger({
        subAccountId: lookup.subAccountId,
        agencyId: lookup.agencyId,
        type: "email.opened",
        contactId: lookup.contactId,
        context: { broadcastId: lookup.broadcastId, templateName },
      });
      return;
    }
    case "email.clicked": {
      await activity(
        "email_clicked",
        `Clicked ${link || "a link"} in bulk email: ${templateName}`,
        { link },
      );
      void fireWorkflowTrigger({
        subAccountId: lookup.subAccountId,
        agencyId: lookup.agencyId,
        type: "email.clicked",
        contactId: lookup.contactId,
        context: { broadcastId: lookup.broadcastId, templateName, link },
      });
      return;
    }
    case "email.bounced": {
      await Promise.all([
        hardBounce
          ? patchContact({ emailBouncedAt: FieldValue.serverTimestamp() })
          : Promise.resolve(),
        activity(
          "email_bounced",
          hardBounce
            ? `Bulk email bounced (${bounceReason}): ${templateName}. Future broadcasts skip this contact until their email address is changed.`
            : `Bulk email bounced (${bounceReason}): ${templateName}. Temporary bounce; the address stays sendable.`,
          { toEmail: send.toEmail, bounceReason, hardBounce },
        ),
      ]);
      return;
    }
    case "email.complained": {
      // Same as clicking unsubscribe; every provider expects this.
      await Promise.all([
        patchContact({ emailOptedOut: true }),
        activity(
          "email_complained",
          `Marked bulk email as spam: ${templateName}. Contact opted out of email.`,
          { toEmail: send.toEmail },
        ),
      ]);
      return;
    }
  }
}
