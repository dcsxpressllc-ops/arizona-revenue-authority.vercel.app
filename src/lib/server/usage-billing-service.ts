import "server-only";

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  computeFeatureFees,
  computeOverage,
  gatesOnNow,
  getEffectiveBilling,
  stampFeaturesOn,
} from "@/lib/server/usage-meter";
import {
  createUsageCharge,
  refreshUsageOverdue,
  usageChargeId,
} from "@/lib/server/billing-service";
import { formatBillingPrice } from "@/lib/billing/status";
import {
  formatUsageMonth,
  monthBefore,
  monthEndExclusive,
  previousMonthKey,
  USAGE_MIN_CHARGE_CENTS,
  USAGE_PAYMENT_TERMS_DAYS,
  USAGE_REMINDER_DAYS_BEFORE,
} from "@/lib/billing/usage";
import type { UsageChargeLine } from "@/types/billing";
import { USAGE_UNIT_META } from "@/lib/billing/usage-units";
import type { SubAccountDoc } from "@/types";
import type { UsageMonthDoc, UsageQuotas, UsageRates, UsageUnit } from "@/types/usage";

/**
 * Daily month close: freeze last month, queue and mint its charge, email it,
 * then reminders and the overdue flag. Every step is idempotent.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const CONCURRENCY = 8;
/** A charge older than this stops retrying its invoice email (reminders take over). */
const INVOICE_EMAIL_RETRY_DAYS = 7;
/** A claim this old with no send recorded belongs to a run that died; take it over. */
const CLAIM_TIMEOUT_MS = 15 * 60 * 1000;
const PENDING_COLLECTION = "usagePendingCharges";

/** How far back an amount below the minimum can still be carried from. */
const CARRY_LOOKBACK_MONTHS = 12;

/**
 * Sub-minimum amount carried into `month` from the last billed month before
 * it, stepping over skipped months so a gap can't lose it.
 */
export async function carriedInFor(
  subAccountId: string,
  month: string,
  currency: string,
  read: (ref: FirebaseFirestore.DocumentReference) => Promise<FirebaseFirestore.DocumentSnapshot> = (ref) =>
    ref.get(),
): Promise<{ cents: number; fromMonth: string | null }> {
  const db = getAdminDb();
  let m = month;
  for (let i = 0; i < CARRY_LOOKBACK_MONTHS; i++) {
    m = monthBefore(m);
    const closed = ((await read(db.doc(`subAccounts/${subAccountId}/usage/${m}`))).data() as
      | { closed?: UsageClosedSnapshot }
      | undefined)?.closed;
    if (!closed || closed.skipped) continue;
    return closed.currency === currency
      ? { cents: Math.max(0, closed.carryOutCents ?? 0), fromMonth: m }
      : { cents: 0, fromMonth: null };
  }
  return { cents: 0, fromMonth: null };
}

export interface UsageClosedSnapshot {
  at: FieldValue | Timestamp;
  /** Not billed (client or agency not rebilled at close, or switched on after the month). */
  skipped?: boolean;
  totalCents: number;
  currency: string;
  lineItems: UsageChargeLine[];
  ratesSnapshot: UsageRates | null;
  includedSnapshot: UsageQuotas | null;
  carriedInCents: number;
  /** Below the minimum: rolls into next month's charge. */
  carryOutCents: number;
  chargeId: string | null;
}

interface PendingChargeDoc {
  subAccountId: string;
  agencyId: string;
  month: string;
  createdAt: Timestamp | FieldValue;
}

function toMillis(v: unknown): number | null {
  if (v instanceof Timestamp) return v.toMillis();
  if (v instanceof Date) return v.getTime();
  return null;
}

/** "YYYY-MM-DD" in UTC, so reminders key off calendar days, not the second the cron ran. */
function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

async function inPool<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item).catch((err) => console.error("[usage-close] item failed", err));
    }
  });
  await Promise.all(workers);
}

export async function runUsageClose(now: Date = new Date()): Promise<{
  seeded: number;
  closed: number;
  charged: number;
  reminded: number;
}> {
  const db = getAdminDb();
  const subs = await db
    .collection("subAccounts")
    .where("usageRebillingEnabled", "==", true)
    .get();

  const prevMonth = previousMonthKey(now);
  const agencyCache = new Map<string, FirebaseFirestore.DocumentData | null>();
  const agencyDoc = async (agencyId: string) => {
    if (!agencyCache.has(agencyId)) {
      const snap = await db.doc(`agencies/${agencyId}`).get();
      agencyCache.set(agencyId, snap.exists ? (snap.data() ?? null) : null);
    }
    return agencyCache.get(agencyId) ?? null;
  };

  let seeded = 0;
  let closed = 0;
  await inPool(subs.docs, async (snap) => {
    const sub = { ...(snap.data() as SubAccountDoc), id: snap.id };
    await stampFeaturesOn(snap.id, gatesOnNow(sub as unknown as Record<string, unknown>));
    seeded++;
    const agency = sub.agencyId ? await agencyDoc(sub.agencyId) : null;
    if (await freezeMonthForSubAccount({ sub, agency, month: prevMonth })) closed++;
  });

  const charged = await processPendingCharges(now);
  const reminded = await sendDueReminders(now);
  return { seeded, closed, charged, reminded };
}

/** Freeze `month` for one client once, queueing its charge in the same write. */
export async function freezeMonthForSubAccount(input: {
  sub: SubAccountDoc;
  agency: FirebaseFirestore.DocumentData | null;
  month: string;
}): Promise<boolean> {
  const { sub, agency, month } = input;
  const db = getAdminDb();
  const ref = db.doc(`subAccounts/${sub.id}/usage/${month}`);
  // Every daily run reaches here; skip the billing lookup once the month is closed.
  if ((await ref.get()).data()?.closed) return false;

  const billing = await getEffectiveBilling(sub.id, sub);
  const monthEnd = monthEndExclusive(month).getTime();
  // Only a month during which both switches were already on is billed. A
  // switch turned off and on again after the month ended counts as off.
  const onBeforeEnd = (since: unknown) => {
    const ms = toMillis(since);
    return ms === null || ms < monthEnd;
  };
  const billable =
    billing.rebilling &&
    agency?.usageRebillingEnabled === true &&
    onBeforeEnd(agency?.usageRebillingSince) &&
    onBeforeEnd(sub.usageRebillingSince);
  const currency = (sub.billing?.currency as string | undefined) ?? "usd";

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const usage = (snap.data() as (UsageMonthDoc & { closed?: UsageClosedSnapshot }) | undefined) ?? {};
    if (usage.closed) return false;

    if (!billable) {
      const skipped: UsageClosedSnapshot = {
        at: FieldValue.serverTimestamp(),
        skipped: true,
        totalCents: 0,
        currency,
        lineItems: [],
        ratesSnapshot: null,
        includedSnapshot: null,
        carriedInCents: 0,
        carryOutCents: 0,
        chargeId: null,
      };
      tx.set(ref, { closed: skipped }, { merge: true });
      return true;
    }

    const carry = await carriedInFor(sub.id, month, currency, (r) => tx.get(r));
    const carriedInCents = carry.cents;

    const overage = computeOverage(usage, billing.quotas, billing.rates);
    const fees = computeFeatureFees(usage, billing.featureFees);
    const lineItems: UsageChargeLine[] = [];
    for (const [unit, v] of Object.entries(overage.perUnit) as [
      UsageUnit,
      { overUnits: number; cents: number },
    ][]) {
      // Same labels as the client's Billing tab.
      const meta = USAGE_UNIT_META.find((u) => u.field === unit);
      if (!meta || v.cents <= 0) continue;
      // Minutes are prorated by the second, so show them to one decimal.
      const detail = meta.minutes
        ? `${(v.overUnits / 60).toFixed(1)} billable min`
        : `${v.overUnits.toLocaleString("en-US")} billable`;
      lineItems.push({ label: meta.label, amountCents: v.cents, detail });
    }
    for (const f of fees.lines) {
      lineItems.push({ label: f.label, amountCents: f.cents, detail: "Monthly fee" });
    }
    if (carriedInCents > 0) {
      lineItems.push({
        label: `Carried from ${formatUsageMonth(carry.fromMonth ?? monthBefore(month))}`,
        amountCents: carriedInCents,
        detail: "Below the minimum charge last month",
      });
    }
    const totalCents = overage.totalCents + fees.totalCents + carriedInCents;
    const charge = totalCents >= USAGE_MIN_CHARGE_CENTS;
    const chargeId = charge ? usageChargeId(sub.id, month) : null;
    const frozen: UsageClosedSnapshot = {
      at: FieldValue.serverTimestamp(),
      totalCents,
      currency,
      lineItems,
      ratesSnapshot: billing.rates,
      includedSnapshot: billing.quotas,
      carriedInCents,
      carryOutCents: charge ? 0 : totalCents,
      chargeId,
    };
    tx.set(ref, { closed: frozen }, { merge: true });
    if (chargeId) {
      const pending: PendingChargeDoc = {
        subAccountId: sub.id,
        agencyId: sub.agencyId,
        month,
        createdAt: FieldValue.serverTimestamp(),
      };
      tx.set(db.doc(`${PENDING_COLLECTION}/${chargeId}`), pending);
    }
    return true;
  });
}

/** Mint queued charges and email each once; entries stay queued until both are done. */
async function processPendingCharges(now: Date): Promise<number> {
  const db = getAdminDb();
  // Normally a handful of entries; read them all so none waits behind others.
  const queue = await db.collection(PENDING_COLLECTION).get();
  let charged = 0;
  await inPool(queue.docs, async (q) => {
    const p = q.data() as PendingChargeDoc;
    const [subSnap, ledger] = await Promise.all([
      db.doc(`subAccounts/${p.subAccountId}`).get(),
      db.doc(`subAccounts/${p.subAccountId}/usage/${p.month}`).get(),
    ]);
    const frozen = (ledger.data() as { closed?: UsageClosedSnapshot } | undefined)?.closed;
    if (!subSnap.exists || !frozen?.chargeId || frozen.skipped) {
      await q.ref.delete();
      return;
    }
    const sub = { ...(subSnap.data() as SubAccountDoc), id: subSnap.id };

    // The due date counts from when the charge is actually created.
    const dueAt = new Date(now.getTime() + USAGE_PAYMENT_TERMS_DAYS * DAY_MS);
    try {
      const created = await createUsageCharge({
        agencyId: p.agencyId,
        subAccountId: p.subAccountId,
        month: p.month,
        description: `Usage — ${formatUsageMonth(p.month)}`,
        amountCents: frozen.totalCents,
        currency: frozen.currency,
        lineItems: frozen.lineItems,
        dueAt,
      });
      if (created.created) charged++;
    } catch (err) {
      console.error(`[usage-close] charge not created sa=${p.subAccountId} month=${p.month}`, err);
      return;
    }

    const chargeRef = db.doc(`billingCharges/${frozen.chargeId}`);
    // Claim the invoice email so overlapping runs can't both send it.
    // "done" drops the queue entry; "busy" leaves it for the run holding the claim.
    const claim = await db.runTransaction(async (tx) => {
      const c = (await tx.get(chargeRef)).data();
      if (!c || c.status !== "pending" || c.emailedTo) return { state: "done" as const };
      // Counted from the charge, so a charge created late still gets its email.
      const createdMs = toMillis(c.createdAt) ?? now.getTime();
      if (now.getTime() - createdMs > INVOICE_EMAIL_RETRY_DAYS * DAY_MS) {
        return { state: "done" as const };
      }
      const claimedMs = toMillis(c.invoiceEmailClaimedAt);
      if (claimedMs !== null && now.getTime() - claimedMs < CLAIM_TIMEOUT_MS) {
        return { state: "busy" as const };
      }
      tx.update(chargeRef, { invoiceEmailClaimedAt: FieldValue.serverTimestamp() });
      return { state: "claimed" as const, c };
    });
    if (claim.state === "busy") return;
    if (claim.state === "done") {
      await q.ref.delete();
      return;
    }
    const c = claim.c;
    const to = await billingRecipient(sub);
    if (!to) {
      await q.ref.delete();
      return;
    }
    const sent = await sendUsageEmail({
      kind: "invoice",
      to,
      sub,
      month: p.month,
      amountCents: Number(c.amountCents ?? frozen.totalCents),
      currency: String(c.currency ?? frozen.currency),
      lineItems: (c.lineItems as UsageChargeLine[] | undefined) ?? frozen.lineItems,
      payUrl: String(c.payUrl ?? ""),
      dueAt: new Date(toMillis(c.dueAt) ?? dueAt.getTime()),
    });
    if (sent) {
      await chargeRef.update({ emailedTo: to, updatedAt: FieldValue.serverTimestamp() });
      await q.ref.delete();
    } else {
      // Release the claim so tomorrow's run tries again.
      await chargeRef.update({ invoiceEmailClaimedAt: FieldValue.delete() }).catch(() => {});
    }
  });
  return charged;
}

/**
 * Who gets the invoice: the workspace's account contact, else an active admin
 * who isn't the agency owner. Null = nobody to email.
 */
export async function billingRecipient(sub: SubAccountDoc): Promise<string | null> {
  const contact = sub.accountContact?.email?.trim();
  if (contact && contact.includes("@")) return contact;
  const db = getAdminDb();
  const agency = sub.agencyId ? (await db.doc(`agencies/${sub.agencyId}`).get()).data() : null;
  const members = await db
    .collection(`subAccounts/${sub.id}/subAccountMembers`)
    .where("role", "==", "admin")
    .get();
  const admin = members.docs
    .map((d) => d.data() as { uid?: string; email?: string; status?: string })
    .find((m) => m.status === "active" && m.uid !== agency?.ownerUid && m.email?.includes("@"));
  return admin?.email ?? null;
}

/** Reminders by UTC calendar day, plus the overdue flag. Dates are checked in memory. */
async function sendDueReminders(now: Date): Promise<number> {
  const db = getAdminDb();
  const pending = await db
    .collection("billingCharges")
    .where("kind", "==", "usage")
    .where("status", "==", "pending")
    .get();
  const today = utcDay(now.getTime());
  const overdueSubs = new Set<string>();
  let sent = 0;
  await inPool(pending.docs, async (doc) => {
    const data = doc.data();
    const dueMs = toMillis(data.dueAt);
    if (dueMs === null) return;
    const dueDay = utcDay(dueMs);
    const warnDay = utcDay(dueMs - USAGE_REMINDER_DAYS_BEFORE * DAY_MS);
    if (today > dueDay) overdueSubs.add(String(data.subAccountId));
    if (!data.payUrl) return;
    // Each stage has its own stamp, so "due today" doesn't suppress the overdue notice.
    const stage: "beforeDue" | "onDue" | "overdue" | null =
      today > dueDay ? "overdue" : today === dueDay ? "onDue" : today >= warnDay ? "beforeDue" : null;
    if (!stage) return;
    // Claim the stamp first so overlapping runs can't both send. A failed send
    // isn't retried; the next stage or the banner follows.
    const claimed = await db.runTransaction(async (tx) => {
      const fresh = await tx.get(doc.ref);
      const d = fresh.data();
      if (!d || d.status !== "pending" || d.remindedAt?.[stage]) return false;
      tx.update(doc.ref, { [`remindedAt.${stage}`]: FieldValue.serverTimestamp() });
      return true;
    });
    if (!claimed) return;
    const subSnap = await db.doc(`subAccounts/${data.subAccountId}`).get();
    if (!subSnap.exists) return;
    const sub = { ...(subSnap.data() as SubAccountDoc), id: subSnap.id };
    const to = await billingRecipient(sub);
    if (!to) return;
    const ok = await sendUsageEmail({
      kind: stage,
      to,
      sub,
      month: String(data.usageMonth ?? ""),
      amountCents: Number(data.amountCents ?? 0),
      currency: String(data.currency ?? "usd"),
      lineItems: (data.lineItems as UsageChargeLine[] | undefined) ?? [],
      payUrl: String(data.payUrl),
      dueAt: new Date(dueMs),
    });
    if (ok) sent++;
  });
  // Re-check every flagged client too, so a flag a failed refresh left behind
  // (paid or waived since) clears within a day.
  const flagged = await db.collection("subAccounts").where("usageOverdue", "!=", null).get();
  for (const d of flagged.docs) overdueSubs.add(d.id);
  await inPool([...overdueSubs], (id) => refreshUsageOverdue(id, now));
  return sent;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function sendUsageEmail(input: {
  kind: "invoice" | "beforeDue" | "onDue" | "overdue";
  to: string;
  sub: SubAccountDoc;
  month: string;
  amountCents: number;
  currency: string;
  lineItems: UsageChargeLine[];
  payUrl: string;
  dueAt: Date;
}): Promise<boolean> {
  if (!input.payUrl) return false;
  try {
    // Dynamic: resend.ts meters through usage-meter, which this module imports.
    const { emailIsConfigured, sendEmail } = await import("@/lib/comms/resend");
    if (!emailIsConfigured()) return false;
    const ws = input.sub.name || "Your workspace";
    const monthLabel = formatUsageMonth(input.month);
    const total = formatBillingPrice(input.amountCents, input.currency);
    const due = input.dueAt.toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });
    const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
    const billingTab = base ? `${base}/sa/${input.sub.id}/dashboard/settings?tab=billing` : null;
    const subject = {
      invoice: `${ws}: usage for ${monthLabel} — ${total}`,
      beforeDue: `Reminder: ${ws} usage for ${monthLabel} is due ${due}`,
      onDue: `${ws} usage for ${monthLabel} is due today`,
      overdue: `${ws} usage for ${monthLabel} is overdue`,
    }[input.kind];
    const intro = {
      invoice: `Here is the usage for ${ws} in ${monthLabel}.`,
      beforeDue: `A friendly reminder: the usage charge for ${ws} (${monthLabel}) is due on ${due}.`,
      onDue: `The usage charge for ${ws} (${monthLabel}) is due today.`,
      overdue: `The usage charge for ${ws} (${monthLabel}) was due on ${due} and is now overdue. Access pauses if it stays unpaid.`,
    }[input.kind];
    const lines = input.lineItems.map(
      (l) =>
        `${l.label}${l.detail ? ` (${l.detail})` : ""}: ${formatBillingPrice(l.amountCents, input.currency)}`,
    );
    const text = [
      intro,
      "",
      ...lines,
      "",
      `Total: ${total}`,
      `Due: ${due}`,
      "",
      `Pay securely here: ${input.payUrl}`,
      ...(billingTab ? ["", `Details and past charges: ${billingTab}`] : []),
    ].join("\n");
    const rows = input.lineItems
      .map(
        (l) =>
          `<tr><td style="padding:6px 0;">${escapeHtml(l.label)}${
            l.detail ? `<br><span style="color:#6b7280;font-size:12px;">${escapeHtml(l.detail)}</span>` : ""
          }</td><td style="padding:6px 0;text-align:right;">${escapeHtml(
            formatBillingPrice(l.amountCents, input.currency),
          )}</td></tr>`,
      )
      .join("");
    const html = `
      <div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:24px;">
        <p>${escapeHtml(intro)}</p>
        <table style="width:100%;border-collapse:collapse;font-size:14px;">${rows}
          <tr><td style="padding:10px 0;border-top:1px solid #e5e7eb;"><strong>Total</strong></td>
          <td style="padding:10px 0;border-top:1px solid #e5e7eb;text-align:right;"><strong>${escapeHtml(total)}</strong></td></tr>
        </table>
        <p style="color:#6b7280;font-size:13px;">Due ${escapeHtml(due)}</p>
        <p style="margin:24px 0;">
          <a href="${escapeHtml(input.payUrl)}" style="background:#4f46e5;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;display:inline-block;">Pay now</a>
        </p>
        ${
          billingTab
            ? `<p style="font-size:13px;"><a href="${escapeHtml(billingTab)}">See details and past charges</a></p>`
            : ""
        }
        <p style="color:#6b7280;font-size:12px;">Payment is handled securely by Stripe. Your card isn't saved.</p>
      </div>`;
    await sendEmail({ to: input.to, subject, text, html });
    return true;
  } catch (err) {
    console.warn(`[usage-close] ${input.kind} email failed sa=${input.sub.id}`, err);
    return false;
  }
}
