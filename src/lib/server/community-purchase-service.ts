import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { buildPaypalAmountUrl } from "@/lib/paypal/payment-link";
import { emitWebhookEvent } from "@/lib/api/webhooks/dispatch";
import { getGroupById } from "@/lib/server/community-service";
import { getCourse } from "@/lib/server/community-classroom-service";
import type { Purchase, PurchaseScope } from "@/types/community";
import { hasCardRail } from "@/lib/payments/can-take-payment";
import type { PayPalConfig } from "@/types";
import type { SubAccountDoc } from "@/types/tenancy";

/**
 * One-time purchases for group access or a single course. PayPal is manual:
 * the member pays via paypal.me and staff click "Mark paid". Card payments
 * flip the same status from a webhook.
 */

function purchasesCol(saId: string, groupId: string) {
  return getAdminDb().collection(
    `subAccounts/${saId}/communityGroups/${groupId}/purchases`,
  );
}

export interface RequestPurchaseResult {
  purchaseId: string;
  /** Empty when PayPal isn't configured (card only). */
  paypalUrl: string;
  status: Purchase["status"];
  amountCents: number;
  currency: string;
  /** Payments gate on and Stripe connection ready. */
  cardAvailable: boolean;
}

export async function requestPurchaseServerSide(opts: {
  subAccountId: string;
  groupId: string;
  memberId: string;
  scope: PurchaseScope;
  targetId: string;
}): Promise<RequestPurchaseResult> {
  const db = getAdminDb();
  const subSnap = await db.doc(`subAccounts/${opts.subAccountId}`).get();
  const sub = subSnap.data();
  const paypal = sub?.paypalConfig as PayPalConfig | null | undefined;
  // Either rail unlocks purchases, so a Stripe-only workspace can sell access.
  // See lib/payments/can-take-payment.
  const cardReady = hasCardRail(sub as Partial<SubAccountDoc>);
  if (!paypal?.username && !cardReady) {
    throw new Error(
      "This group hasn't set up payments yet. Contact the group owner.",
    );
  }
  const agencyId = (sub?.agencyId as string) ?? "";

  let amountCents: number;
  let currency: string;
  if (opts.scope === "group") {
    const group = await getGroupById(opts.subAccountId, opts.groupId);
    if (!group || group.access !== "paid" || !group.priceCents) {
      throw new Error("This group isn't a paid group.");
    }
    amountCents = group.priceCents;
    currency = group.currency ?? "USD";
  } else {
    const course = await getCourse(opts.subAccountId, opts.groupId, opts.targetId);
    if (!course || course.access !== "purchase" || !course.priceCents) {
      throw new Error("This course isn't for sale.");
    }
    amountCents = course.priceCents;
    currency = course.currency ?? "USD";
  }

  // Reuse an open pending purchase for the same member + target.
  const existing = await purchasesCol(opts.subAccountId, opts.groupId)
    .where("memberId", "==", opts.memberId)
    .where("scope", "==", opts.scope)
    .where("targetId", "==", opts.targetId)
    .where("status", "==", "pending")
    .limit(5)
    .get();
  // Order-backed purchases are granted by the order, never paid here.
  const doc = existing.docs.find((d) => !d.data().orderId);
  if (doc) {
    return {
      purchaseId: doc.id,
      paypalUrl: (doc.data().paypalUrl as string) ?? "",
      status: "pending",
      amountCents: (doc.data().amountCents as number) ?? amountCents,
      currency: (doc.data().currency as string) ?? currency,
      cardAvailable: cardReady,
    };
  }

  // "" rather than null so the stored shape stays constant.
  const paypalUrl = paypal?.username
    ? buildPaypalAmountUrl({ paypal, amount: amountCents / 100, currency })
    : "";

  const ref = await purchasesCol(opts.subAccountId, opts.groupId).add({
    subAccountId: opts.subAccountId,
    agencyId,
    groupId: opts.groupId,
    memberId: opts.memberId,
    scope: opts.scope,
    targetId: opts.targetId,
    amountCents,
    currency,
    paypalUrl,
    status: "pending",
    grantedByUid: null,
    requestedAt: FieldValue.serverTimestamp(),
    paidAt: null,
  });

  return {
    purchaseId: ref.id,
    paypalUrl,
    status: "pending",
    amountCents,
    currency,
    cardAvailable: cardReady,
  };
}

/**
 * A pending purchase for access bought with a product order. Same shape as
 * requestPurchaseServerSide, minus the payment-rail checks (the order already
 * paid). Deterministic id, so a re-run finds the existing doc.
 */
export async function createPurchaseForOrderServerSide(opts: {
  subAccountId: string;
  agencyId: string;
  groupId: string;
  scope: PurchaseScope;
  targetId: string;
  memberId: string;
  currency: string;
  orderId: string;
  purchaseId: string;
}): Promise<string> {
  const ref = purchasesCol(opts.subAccountId, opts.groupId).doc(opts.purchaseId);
  try {
    await ref.create({
      subAccountId: opts.subAccountId,
      agencyId: opts.agencyId,
      groupId: opts.groupId,
      memberId: opts.memberId,
      scope: opts.scope,
      targetId: opts.targetId,
      // The money lives on the order; a zero here keeps webhook totals from
      // counting it twice and stops the pay route charging for it.
      amountCents: 0,
      currency: opts.currency.toUpperCase(),
      paypalUrl: "",
      status: "pending",
      grantedByUid: null,
      requestedAt: FieldValue.serverTimestamp(),
      paidAt: null,
      orderId: opts.orderId,
    });
  } catch (err) {
    // 6 = ALREADY_EXISTS: an earlier run created it.
    if ((err as { code?: number }).code !== 6) throw err;
  }
  return ref.id;
}

/** Drives the course unlock check. */
export async function hasPaidCourse(
  saId: string,
  groupId: string,
  courseId: string,
  memberId: string,
): Promise<boolean> {
  const snap = await purchasesCol(saId, groupId)
    .where("memberId", "==", memberId)
    .where("scope", "==", "course")
    .where("targetId", "==", courseId)
    .where("status", "==", "paid")
    .limit(1)
    .get();
  return !snap.empty;
}

/** Staff: mark paid and grant the access it bought. */
export async function markPurchasePaidServerSide(opts: {
  subAccountId: string;
  groupId: string;
  purchaseId: string;
  grantedByUid: string;
}): Promise<{ ok: boolean }> {
  const db = getAdminDb();
  const ref = purchasesCol(opts.subAccountId, opts.groupId).doc(opts.purchaseId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error("Purchase not found");
  const purchase = { id: snap.id, ...(snap.data() as Omit<Purchase, "id">) };
  if (purchase.status === "paid") return { ok: true };

  await ref.update({
    status: "paid",
    paidAt: FieldValue.serverTimestamp(),
    grantedByUid: opts.grantedByUid,
  });

  if (purchase.scope === "group") {
    const groupRef = db.doc(
      `subAccounts/${opts.subAccountId}/communityGroups/${opts.groupId}`,
    );
    const memRef = groupRef.collection("memberships").doc(purchase.memberId);
    const existing = await memRef.get();
    const wasActive =
      existing.exists && existing.data()!.status === "active";
    await memRef.set(
      {
        subAccountId: opts.subAccountId,
        agencyId: purchase.agencyId,
        groupId: opts.groupId,
        memberId: purchase.memberId,
        role: "member",
        status: "active",
        points: existing.data()?.points ?? 0,
        level: existing.data()?.level ?? 1,
        joinedAt: existing.data()?.joinedAt ?? FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    if (!wasActive) {
      await groupRef.update({ memberCount: FieldValue.increment(1) });
      void emitWebhookEvent({
        subAccountId: opts.subAccountId,
        agencyId: purchase.agencyId,
        mode: "live",
        type: "community.member.joined",
        payload: {
          groupId: opts.groupId,
          memberId: purchase.memberId,
          via: "purchase",
        },
      });
    }
  }
  // Course access is read live from the paid purchase; nothing else to write.

  void emitWebhookEvent({
    subAccountId: opts.subAccountId,
    agencyId: purchase.agencyId,
    mode: "live",
    type: "community.purchase.paid",
    payload: {
      purchaseId: purchase.id,
      groupId: opts.groupId,
      memberId: purchase.memberId,
      scope: purchase.scope,
      targetId: purchase.targetId,
      amountCents: purchase.amountCents,
      currency: purchase.currency,
    },
  });

  return { ok: true };
}
