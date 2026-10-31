import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { emailIsConfigured, sendEmail, tenantFrom } from "@/lib/comms/resend";
import { orderDelivers } from "@/lib/server/entitlements-service";
import type { Order } from "@/types/orders";
import type { SubAccountDoc } from "@/types/tenancy";

/**
 * Plain-text order confirmation from the sub-account to the buyer, for orders
 * that carry no email of their own (buy links and checkout pages). Stripe's
 * receipt depends on a setting in the client's Stripe account, so this is the
 * one email a buyer can count on. Never throws.
 */

export interface ConfirmationResult {
  ok: boolean;
  error: string | null;
}

function money(cents: number, currency: string): string {
  const code = currency.toUpperCase();
  try {
    const n = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code,
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(cents / 100);
    return `${n} ${code}`;
  } catch {
    return `${(cents / 100).toFixed(2)} ${code}`;
  }
}

function paidDate(order: Order): string {
  const at = order.paidAt as { toMillis?: () => number } | null;
  const ms = typeof at?.toMillis === "function" ? at.toMillis() : Date.now();
  return new Date(ms).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Short, stable reference the buyer can quote back to support. */
export function orderReference(orderId: string): string {
  return orderId.slice(0, 8).toUpperCase();
}

/** Download links this email carries itself; the delivery step then skips its own email. */
export function confirmationDownloads(
  order: Order,
): { productId: string; name: string; label: string; url: string }[] {
  return (order.deliveries ?? []).flatMap((d) => {
    if (d.delivery.type !== "download" || !/^https:\/\//.test(d.delivery.url)) return [];
    const name = order.lineItems.find((li) => li.productId === d.productId)?.name ?? "Your purchase";
    return [{
      productId: d.productId,
      name,
      label: d.delivery.label?.trim() || "Download",
      url: d.delivery.url,
    }];
  });
}

function nextSteps(order: Order): string {
  const downloads = confirmationDownloads(order);
  const community = (order.deliveries ?? []).some((d) => d.delivery.type === "community");
  const lines: string[] = [];
  if (downloads.length) {
    lines.push(downloads.length === 1 ? "Your download:" : "Your downloads:");
    for (const d of downloads) {
      lines.push(downloads.length === 1 ? `  ${d.label}: ${d.url}` : `  ${d.name} (${d.label}): ${d.url}`);
    }
    lines.push("", "Keep this email so you can download it again later.");
  }
  if (community) {
    if (lines.length) lines.push("");
    lines.push(
      "Your sign-in link is in a separate email, sent at the same time as this one.",
      "If it hasn't arrived within a few minutes, check your spam folder or reply to this email.",
    );
  }
  if (!lines.length) lines.push("We'll be in touch soon about next steps.");
  return lines.join("\n");
}

export function renderOrderConfirmation(
  order: Order,
  sub: Partial<SubAccountDoc>,
): { subject: string; text: string } {
  const business = sub.name?.trim() || "us";
  const first = order.buyerName?.trim().split(/\s+/)[0];
  const items = order.lineItems
    .map((li) => {
      const qty = li.quantity > 1 ? ` x ${li.quantity}` : "";
      return `  ${li.name}${qty}  ${money(li.unitPriceCents * li.quantity, order.currency)}`;
    })
    .join("\n");
  const main = order.lineItems.find((li) => !li.isBump) ?? order.lineItems[0];
  const test = order.livemode === false ? "[Test] " : "";

  const subject = `${test}Order confirmed: ${main?.name ?? "your order"}`;
  const text = `Hi ${first || "there"},

Thanks for your order with ${business}. Your payment went through.

Order reference: ${orderReference(order.id)}
Date: ${paidDate(order)}

${items}

Total paid: ${money(order.totalCents, order.currency)}

${nextSteps(order)}

Questions about your order? Just reply to this email.

${business === "us" ? "" : business}
`.replace(/\n+$/, "\n");
  return { subject, text };
}

async function record(
  order: Order,
  result: ConfirmationResult,
  email: string | null,
): Promise<void> {
  const db = getAdminDb();
  await db
    .doc(`orders/${order.id}`)
    .update({
      confirmationEmail: {
        state: result.ok ? "sent" : "failed",
        error: result.error,
        at: Date.now(),
      },
    })
    .catch((err) => console.warn(`[order-confirmation] status write failed order=${order.id}`, err));
  if (!order.contactId) return;
  await db
    .collection(`contacts/${order.contactId}/activities`)
    .add({
      type: result.ok ? "order_confirmation_sent" : "order_confirmation_failed",
      content: result.ok
        ? `Order confirmation emailed to ${email}.`
        : `Order confirmation not sent: ${result.error}`,
      createdBy: "system",
      meta: { orderId: order.id },
      createdAt: FieldValue.serverTimestamp(),
    })
    .catch((err) => console.warn(`[order-confirmation] activity write failed order=${order.id}`, err));
}

export async function sendOrderConfirmation(order: Order): Promise<ConfirmationResult> {
  if (!orderDelivers(order)) {
    return { ok: false, error: "This kind of order sends its own email." };
  }
  const email = order.buyerEmail?.trim().toLowerCase() || null;
  let result: ConfirmationResult;
  try {
    if (!email) {
      result = { ok: false, error: "The order has no buyer email." };
    } else if (!emailIsConfigured()) {
      result = { ok: false, error: "Email isn't set up on this deployment." };
    } else {
      const snap = await getAdminDb().doc(`subAccounts/${order.subAccountId}`).get();
      const sub = (snap.data() ?? {}) as Partial<SubAccountDoc>;
      const { subject, text } = renderOrderConfirmation(order, sub);
      // Buyer replies should reach the business, not the shared sender.
      const replyTo =
        sub.replyToEmail?.trim() || sub.accountContact?.email?.trim() || undefined;
      await sendEmail({
        to: email,
        from: tenantFrom(sub),
        subAccount: sub,
        replyTo,
        meter: { subAccountId: order.subAccountId },
        subject,
        text,
      });
      result = { ok: true, error: null };
    }
  } catch (err) {
    console.error(`[order-confirmation] send failed order=${order.id}`, err);
    result = { ok: false, error: "The email provider refused the send." };
  }
  await record(order, result, email);
  return result;
}
