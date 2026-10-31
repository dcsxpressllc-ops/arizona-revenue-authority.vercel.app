import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { emailIsConfigured, sendEmail, tenantFrom } from "@/lib/comms/resend";
import { ensureMember } from "@/lib/community/member-account";
import { signMemberMagicLinkToken } from "@/lib/community/member-auth";
import { getCourse } from "@/lib/server/community-classroom-service";
import { getGroupById, getMembership } from "@/lib/server/community-service";
import {
  createPurchaseForOrderServerSide,
  markPurchasePaidServerSide,
} from "@/lib/server/community-purchase-service";
import type { Entitlement } from "@/types/entitlements";
import type { Order, OrderDeliverySnapshot } from "@/types/orders";
import type { SubAccountDoc } from "@/types/tenancy";

/**
 * Delivers what a paid product order bought: community access or a download
 * link. Reads the order's delivery snapshot, never the live product, and
 * ignores the Sell online gate (a paid buyer is always fulfilled). Failures
 * are recorded on the entitlement and the contact, never thrown.
 */

export const PRODUCT_GRANTOR = "system:stripe";
/**
 * Purchase emails are often opened hours later, so the link outlives the usual
 * 15 minutes. Links aren't single use, so keep this short.
 */
const DELIVERY_LINK_TTL_MS = 24 * 60 * 60 * 1000;

type Delivery = OrderDeliverySnapshot["delivery"];

export function entitlementId(orderId: string, productId: string): string {
  return `${orderId}_${productId}`;
}

/** Only these sources deliver; invoices, deposits and community orders carry their own effects. */
export function orderDelivers(order: Pick<Order, "source">): boolean {
  return order.source === "product_link" || order.source === "checkout_page";
}

function appUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

class DeliveryError extends Error {}

export interface GrantSummary {
  delivered: number;
  failed: number;
  skipped: number;
}

/**
 * Grant every delivery on a paid order. `resend` re-runs deliveries that
 * already succeeded (staff "Re-send delivery"): community grants are
 * idempotent, so only the email goes out again.
 */
export async function grantForOrder(
  order: Order,
  opts: {
    resend?: boolean;
    /** The order confirmation already carried the download links, so don't email them again. */
    downloadsEmailed?: boolean;
  } = {},
): Promise<GrantSummary> {
  const summary: GrantSummary = { delivered: 0, failed: 0, skipped: 0 };
  if (!orderDelivers(order)) return summary;
  const deliveries = order.deliveries ?? [];
  if (deliveries.length === 0) return summary;
  if (order.status !== "paid" && order.status !== "partially_refunded") return summary;

  const db = getAdminDb();
  let sub: Partial<SubAccountDoc> = {};
  try {
    sub = ((await db.doc(`subAccounts/${order.subAccountId}`).get()).data() ??
      {}) as Partial<SubAccountDoc>;
  } catch (err) {
    console.warn(`[entitlements] sub-account read failed order=${order.id}`, err);
  }
  const errors: string[] = [];

  for (const d of deliveries) {
    const productName =
      order.lineItems.find((li) => li.productId === d.productId)?.name ?? "your purchase";
    const ref = db.doc(`entitlements/${entitlementId(order.id, d.productId)}`);
    let claimed = false;
    let memberId: string | null = null;
    try {
      const claim = await claimDelivery(ref, order, d, productName, !!opts.resend);
      if (claim !== "claimed") {
        summary.skipped += 1;
        continue;
      }
      claimed = true;
      const email = order.buyerEmail?.trim().toLowerCase();
      if (!email) throw new DeliveryError("The order has no buyer email.");
      if (d.delivery.type === "community") {
        const res = await deliverCommunity({
          order,
          sub,
          delivery: d.delivery,
          email,
          productName,
          productId: d.productId,
        });
        memberId = res.memberId;
        if (res.problem) throw new DeliveryError(res.problem);
      } else {
        await deliverDownload({
          order,
          sub,
          delivery: d.delivery,
          email,
          productName,
          skipEmail: !!opts.downloadsEmailed,
        });
      }
      await ref.update({
        fulfilment: { state: "done", error: null, at: Date.now(), memberId },
        sends: FieldValue.increment(1),
        // The contact may have been created after the entitlement.
        contactId: order.contactId,
      });
      summary.delivered += 1;
      await writeActivity(
        order,
        "product_delivered",
        deliveredText(productName, d.delivery, email, !!opts.downloadsEmailed),
      );
    } catch (err) {
      const message =
        err instanceof DeliveryError
          ? err.message
          : "Something went wrong delivering it. Try Re-send delivery from Reports > Payments.";
      if (!(err instanceof DeliveryError)) {
        console.error(`[entitlements] delivery failed order=${order.id} product=${d.productId}`, err);
      }
      if (claimed) {
        await ref
          .update({
            fulfilment: { state: "failed", error: message.slice(0, 300), at: Date.now(), memberId },
            contactId: order.contactId,
          })
          .catch(() => {});
      }
      summary.failed += 1;
      errors.push(`${productName}: ${message}`);
      await writeActivity(order, "delivery_failed", `Delivery failed for ${productName}: ${message}`);
    }
  }

  if (summary.delivered + summary.failed > 0) {
    await db
      .doc(`orders/${order.id}`)
      .update({
        deliveryStatus: {
          state: summary.failed > 0 ? "failed" : "done",
          error: errors.length ? errors.join(" ").slice(0, 300) : null,
          at: Date.now(),
        },
      })
      .catch((err) => console.warn(`[entitlements] order roll-up failed order=${order.id}`, err));
  }
  return summary;
}

/** A claim older than this is treated as a run that died, and may be retaken. */
const CLAIM_LEASE_MS = 2 * 60_000;

/**
 * Take the delivery for this run, so a staff re-send and a webhook (or a
 * double click) can't both send it.
 */
async function claimDelivery(
  ref: FirebaseFirestore.DocumentReference,
  order: Order,
  d: OrderDeliverySnapshot,
  productName: string,
  resend: boolean,
): Promise<"claimed" | "skip"> {
  return getAdminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const sending = { state: "sending", error: null, at: Date.now() };
    if (!snap.exists) {
      tx.create(ref, {
        agencyId: order.agencyId,
        subAccountId: order.subAccountId,
        contactId: order.contactId,
        buyerEmail: order.buyerEmail,
        orderId: order.id,
        productId: d.productId,
        productName,
        delivery: d.delivery,
        status: "active",
        fulfilment: sending,
        sends: 0,
        livemode: order.livemode,
        createdAt: FieldValue.serverTimestamp(),
      });
      return "claimed";
    }
    const e = snap.data() as Entitlement;
    if (e.status === "revoked") return "skip";
    const f = e.fulfilment;
    if (f?.state === "sending" && Date.now() - (f.at ?? 0) < CLAIM_LEASE_MS) return "skip";
    if (f?.state === "done" && !resend) return "skip";
    tx.update(ref, { fulfilment: { ...sending, memberId: f?.memberId ?? null } });
    return "claimed";
  });
}

function deliveredText(
  productName: string,
  delivery: Delivery,
  email: string,
  inConfirmation: boolean,
): string {
  if (delivery.type === "community") {
    return `Delivered ${productName}: community access granted, sign-in link sent to ${email}.`;
  }
  return inConfirmation
    ? `Delivered ${productName}: download link included in the order confirmation to ${email}.`
    : `Delivered ${productName}: download link sent to ${email}.`;
}

async function deliverCommunity(input: {
  order: Order;
  sub: Partial<SubAccountDoc>;
  delivery: Extract<Delivery, { type: "community" }>;
  email: string;
  productName: string;
  productId: string;
}): Promise<{ memberId: string; problem?: string }> {
  const { order, sub, delivery, email, productName, productId } = input;
  const saId = order.subAccountId;
  const group = await getGroupById(saId, delivery.communityGroupId);
  if (!group) throw new DeliveryError("The community group no longer exists.");
  const course = delivery.courseId
    ? await getCourse(saId, group.id, delivery.courseId)
    : null;
  if (delivery.courseId && !course) {
    throw new DeliveryError("The course no longer exists in that group.");
  }

  const member = await ensureMember({
    subAccountId: saId,
    email,
    displayName: order.buyerName,
  });
  if (member.status !== "active") {
    throw new DeliveryError("This buyer's community account is deactivated.");
  }
  const membership = await getMembership(saId, group.id, member.id);
  if (membership?.status === "banned") {
    throw new DeliveryError("This buyer is banned from the group, so access wasn't granted.");
  }

  // A course product grants its group as well, so the buyer can reach it. An
  // active member keeps their membership as is (a re-grant would reset a
  // moderator to member).
  const grants: { scope: "group" | "course"; targetId: string; suffix: string }[] = [];
  if (membership?.status !== "active") {
    grants.push({ scope: "group", targetId: group.id, suffix: "g" });
  }
  if (course) grants.push({ scope: "course", targetId: course.id, suffix: "c" });
  for (const g of grants) {
    const purchaseId = await createPurchaseForOrderServerSide({
      subAccountId: saId,
      agencyId: order.agencyId,
      groupId: group.id,
      scope: g.scope,
      targetId: g.targetId,
      memberId: member.id,
      currency: order.currency,
      orderId: order.id,
      purchaseId: `order_${order.id}_${productId}_${g.suffix}`,
    });
    await markPurchasePaidServerSide({
      subAccountId: saId,
      groupId: group.id,
      purchaseId,
      grantedByUid: PRODUCT_GRANTOR,
    });
  }

  if (sub.communityEnabledByAgency !== true) {
    return {
      memberId: member.id,
      problem:
        "Access was granted, but Community is turned off for this workspace, so no sign-in email was sent.",
    };
  }
  if (!emailIsConfigured()) {
    return {
      memberId: member.id,
      problem: "Access was granted, but email isn't set up, so no sign-in email was sent.",
    };
  }

  const token = signMemberMagicLinkToken(saId, email, group.id, DELIVERY_LINK_TTL_MS);
  const link = `${appUrl()}/api/community/${saId}/login/verify?token=${encodeURIComponent(token)}`;
  const loginUrl = `${appUrl()}/c/${saId}/login`;
  const business = sub.name || "us";
  const what = course ? `the ${course.title} course in ${group.name}` : group.name;

  await sendEmail({
    to: email,
    from: tenantFrom(sub),
    subAccount: sub,
    meter: { subAccountId: saId },
    subject: `Your access to ${productName}`,
    text: `Thanks for buying ${productName} from ${business}.

You now have access to ${what}. Use this link to sign in:

${link}

The link works for 24 hours. After that, sign in at ${loginUrl} with this email address and we'll send you a fresh link.
`,
    html: `<!DOCTYPE html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:32px auto;padding:0 16px;color:#202124;line-height:1.6;">
  <h1 style="font-size:20px;font-weight:600;margin:0 0 16px;">You're in</h1>
  <p style="margin:0 0 16px;color:#3a3a44;">Thanks for buying <strong>${esc(productName)}</strong> from ${esc(business)}. You now have access to ${esc(what)}.</p>
  <p style="margin:0 0 24px;">
    <a href="${link}" style="display:inline-block;background:#202124;color:#ffffff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:500;">Sign in</a>
  </p>
  <p style="margin:0;font-size:13px;color:#606068;">The button works for 24 hours. After that, sign in at <a href="${loginUrl}" style="color:#606068;">${esc(loginUrl)}</a> with this email address and we'll send you a fresh link.</p>
</body></html>`,
  });
  return { memberId: member.id };
}

async function deliverDownload(input: {
  order: Order;
  sub: Partial<SubAccountDoc>;
  delivery: Extract<Delivery, { type: "download" }>;
  email: string;
  productName: string;
  skipEmail: boolean;
}): Promise<void> {
  const { order, sub, delivery, email, productName } = input;
  if (!/^https:\/\//.test(delivery.url)) {
    throw new DeliveryError("The download link isn't a valid https link.");
  }
  if (input.skipEmail) return;
  if (!emailIsConfigured()) {
    throw new DeliveryError(
      "Email isn't set up, so the link wasn't emailed. The buyer saw it on the thank-you page.",
    );
  }
  const business = sub.name || "us";
  const label = delivery.label?.trim() || "Download";
  await sendEmail({
    to: email,
    from: tenantFrom(sub),
    subAccount: sub,
    meter: { subAccountId: order.subAccountId },
    subject: `Your download: ${productName}`,
    text: `Thanks for buying ${productName} from ${business}.

${label}: ${delivery.url}

Keep this email so you can download it again later.
`,
    html: `<!DOCTYPE html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:32px auto;padding:0 16px;color:#202124;line-height:1.6;">
  <h1 style="font-size:20px;font-weight:600;margin:0 0 16px;">Your download is ready</h1>
  <p style="margin:0 0 24px;color:#3a3a44;">Thanks for buying <strong>${esc(productName)}</strong> from ${esc(business)}.</p>
  <p style="margin:0 0 24px;">
    <a href="${esc(delivery.url)}" style="display:inline-block;background:#202124;color:#ffffff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:500;">${esc(label)}</a>
  </p>
  <p style="margin:0;font-size:13px;color:#606068;">Keep this email so you can download it again later.</p>
</body></html>`,
  });
}

async function writeActivity(
  order: Pick<Order, "id" | "contactId">,
  type: "product_delivered" | "delivery_failed" | "delivery_revoked",
  content: string,
): Promise<void> {
  if (!order.contactId) return;
  try {
    await getAdminDb()
      .collection(`contacts/${order.contactId}/activities`)
      .add({
        type,
        content: content.slice(0, 500),
        createdBy: "system",
        meta: { orderId: order.id },
        createdAt: FieldValue.serverTimestamp(),
      });
  } catch (err) {
    console.warn(`[entitlements] activity write failed order=${order.id}`, err);
  }
}

/**
 * Full refund: mark the order's entitlements revoked so they can't be
 * re-sent. Community access is left in place for staff to remove by hand.
 */
export async function revokeForOrder(order: Order): Promise<number> {
  if (!orderDelivers(order) || !(order.deliveries?.length)) return 0;
  const db = getAdminDb();
  let revoked = 0;
  for (const d of order.deliveries) {
    const ref = db.doc(`entitlements/${entitlementId(order.id, d.productId)}`);
    const changed = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const e = snap.data() as Entitlement | undefined;
      if (!snap.exists || e?.status === "revoked") return null;
      tx.update(ref, { status: "revoked", revokedAt: FieldValue.serverTimestamp() });
      return e ?? null;
    });
    if (!changed) continue;
    revoked += 1;
    await writeActivity(
      order,
      "delivery_revoked",
      changed.delivery.type === "community"
        ? `Refunded ${changed.productName}. Their community access was not removed automatically; remove them from the group if needed.`
        : `Refunded ${changed.productName}. The download link was already sent and still works.`,
    );
  }
  return revoked;
}
