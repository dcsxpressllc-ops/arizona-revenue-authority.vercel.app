import "server-only";

import type { BookingPage } from "@/types/booking";

/**
 * Booking lifecycle emails. Pure: returns `{ subject, text, html }` for the
 * route to pass to sendEmail(). Covers confirmation, payment pending, reminder,
 * cancelled (including payment-hold expiry) and the host notification.
 *
 * Times render in the booking page's timezone so both sides see the same
 * "what we agreed to".
 */

export interface EmailRenderInput {
  /** Falls back to "there". */
  recipientName: string;
  /** Used in the salutation and header. */
  businessName: string;
  businessLogoUrl?: string | null;
  page: Pick<BookingPage, "name" | "durationMinutes" | "timezone" | "payment" | "confirmationMessage">;
  /** UTC. */
  startAt: Date;
  /** UTC. */
  endAt: Date;
  /** Free text, e.g. "Phone: +61 ..." or "Zoom link follows". */
  location?: string;
  /** Snapshotted from the page at booking time. Adds a "Join the meeting" button when set. */
  meetingUrl?: string | null;
  /** /e/[token] for reschedule and cancel. "" when APP_URL is unset. */
  publicEventUrl: string;
  /** PayPal.me link, only when payment is required. */
  paymentUrl?: string | null;
  /**
   * Shown only when the customer picked a specific host. Display name only,
   * never an email or uid.
   */
  hostName?: string | null;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

/** e.g. "Tue, 30 May 2026 · 14:00 AEST" in the page's timezone. */
export function formatStartLocal(startAt: Date, tz: string): string {
  const fmt = new Intl.DateTimeFormat(undefined, {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  return fmt.format(startAt);
}

/** Used both before and after payment. */
export function renderBookingConfirmationEmail(
  input: EmailRenderInput,
): RenderedEmail {
  const whenLocal = formatStartLocal(input.startAt, input.page.timezone);
  const greeting = `Hi ${input.recipientName?.split(" ")[0] || "there"},`;
  const confirmation =
    input.page.confirmationMessage?.trim() ||
    `Your ${input.page.name} is confirmed.`;

  const subject = `Confirmed: ${input.page.name} on ${whenLocal}`;

  const text = [
    greeting,
    "",
    confirmation,
    "",
    `When: ${whenLocal} (${input.page.durationMinutes} min)`,
    input.hostName ? `With: ${input.hostName}` : null,
    input.meetingUrl ? `Join the meeting: ${input.meetingUrl}` : null,
    input.location ? `Where: ${input.location}` : null,
    "",
    input.publicEventUrl
      ? `Manage your booking (reschedule / cancel): ${input.publicEventUrl}`
      : null,
    "",
    `Thanks,`,
    input.businessName,
  ]
    .filter((s): s is string => s !== null)
    .join("\n");

  const html = wrapHtml(
    input.businessName,
    input.businessLogoUrl ?? null,
    `
      <h1 style="font-size:20px;margin:0 0 12px;">${escapeHtml(input.page.name)}</h1>
      <p style="margin:0 0 16px;color:#3a3a44;">${escapeHtml(greeting)}</p>
      <p style="margin:0 0 16px;">${escapeHtml(confirmation)}</p>
      <table role="presentation" style="width:100%;border-collapse:collapse;margin:16px 0 24px;background:#f6f7f9;border-radius:8px;">
        <tr><td style="padding:10px 16px;font-size:14px;"><strong>When:</strong> ${escapeHtml(whenLocal)} (${input.page.durationMinutes} min)</td></tr>
        ${input.hostName ? `<tr><td style="padding:0 16px 10px;font-size:14px;"><strong>With:</strong> ${escapeHtml(input.hostName)}</td></tr>` : ""}
        ${input.location ? `<tr><td style="padding:0 16px 10px;font-size:14px;"><strong>Where:</strong> ${escapeHtml(input.location)}</td></tr>` : ""}
      </table>
      ${input.meetingUrl ? primaryCta(input.meetingUrl, "Join the meeting") : ""}
      ${input.publicEventUrl ? `<p style="margin:16px 0 0;font-size:13px;color:#6a6a74;">Need to reschedule or cancel? <a href="${escapeHtml(input.publicEventUrl)}" style="color:#0F766E;">Manage your booking</a>.</p>` : ""}
    `,
  );

  return { subject, text, html };
}

export interface HostNotificationInput {
  /** For the greeting. */
  hostName: string;
  businessName: string;
  businessLogoUrl?: string | null;
  page: Pick<BookingPage, "name" | "durationMinutes" | "timezone">;
  startAt: Date;
  endAt: Date;
  /** Full contact details are fine here; this email is internal. */
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  /** "Label: value" per line, or null. */
  notes?: string | null;
  /** Operator-facing event URL, or null. */
  manageUrl?: string | null;
}

/**
 * Internal email to the assigned host. Unlike the customer templates it
 * includes the customer's contact details. Sent for web and voice bookings;
 * best-effort at the call site.
 */
export function renderBookingHostNotificationEmail(
  input: HostNotificationInput,
): RenderedEmail {
  const whenLocal = formatStartLocal(input.startAt, input.page.timezone);
  const greeting = `Hi ${input.hostName?.split(" ")[0] || "there"},`;
  const subject = `New booking: ${input.page.name} with ${input.customerName} on ${whenLocal}`;

  const text = [
    greeting,
    "",
    `You've been assigned a new booking.`,
    "",
    `What: ${input.page.name} (${input.page.durationMinutes} min)`,
    `When: ${whenLocal}`,
    `Who: ${input.customerName}`,
    `Email: ${input.customerEmail || "(not provided)"}`,
    `Phone: ${input.customerPhone || "(not provided)"}`,
    input.notes ? "" : null,
    input.notes ? input.notes : null,
    "",
    input.manageUrl ? `View the booking: ${input.manageUrl}` : null,
    "",
    input.businessName,
  ]
    .filter((s): s is string => s !== null)
    .join("\n");

  const html = wrapHtml(
    input.businessName,
    input.businessLogoUrl ?? null,
    `
      <h1 style="font-size:20px;margin:0 0 12px;">New booking assigned to you</h1>
      <p style="margin:0 0 16px;color:#3a3a44;">${escapeHtml(greeting)}</p>
      <table role="presentation" style="width:100%;border-collapse:collapse;margin:16px 0 24px;background:#f6f7f9;border-radius:8px;">
        <tr><td style="padding:10px 16px;font-size:14px;"><strong>What:</strong> ${escapeHtml(input.page.name)} (${input.page.durationMinutes} min)</td></tr>
        <tr><td style="padding:0 16px 10px;font-size:14px;"><strong>When:</strong> ${escapeHtml(whenLocal)}</td></tr>
        <tr><td style="padding:0 16px 10px;font-size:14px;"><strong>Who:</strong> ${escapeHtml(input.customerName)}</td></tr>
        <tr><td style="padding:0 16px 10px;font-size:14px;"><strong>Email:</strong> ${escapeHtml(input.customerEmail || "(not provided)")}</td></tr>
        <tr><td style="padding:0 16px 10px;font-size:14px;"><strong>Phone:</strong> ${escapeHtml(input.customerPhone || "(not provided)")}</td></tr>
        ${input.notes ? `<tr><td style="padding:0 16px 10px;font-size:14px;white-space:pre-line;">${escapeHtml(input.notes)}</td></tr>` : ""}
      </table>
      ${input.manageUrl ? `<p style="margin:16px 0 0;font-size:13px;color:#6a6a74;"><a href="${escapeHtml(input.manageUrl)}" style="color:#0F766E;">View the booking</a>.</p>` : ""}
    `,
  );

  return { subject, text, html };
}

/** Slot held, payment not cleared yet. */
export function renderBookingPaymentPendingEmail(
  input: EmailRenderInput,
): RenderedEmail {
  if (!input.paymentUrl) {
    throw new Error("renderBookingPaymentPendingEmail requires paymentUrl");
  }
  const whenLocal = formatStartLocal(input.startAt, input.page.timezone);
  const amount = input.page.payment
    ? `${input.page.payment.currency} ${input.page.payment.amount}`
    : "your deposit";
  const greeting = `Hi ${input.recipientName?.split(" ")[0] || "there"},`;

  const subject = `Action needed: pay to confirm your ${input.page.name}`;

  const text = [
    greeting,
    "",
    `Your slot is held for ${input.page.name} on ${whenLocal}.`,
    input.location ? `Where: ${input.location}` : null,
    "",
    `To lock it in, please pay ${amount} via PayPal:`,
    input.paymentUrl,
    "",
    `Once we see the payment land we'll send a confirmation. If we don't see it within ${input.page.payment?.holdHours ?? 24} hours, the slot will be released automatically.`,
    "",
    `Thanks,`,
    input.businessName,
  ]
    .filter((line) => line !== null)
    .join("\n");

  const html = wrapHtml(
    input.businessName,
    input.businessLogoUrl ?? null,
    `
      <h1 style="font-size:20px;margin:0 0 12px;">Pay to confirm your booking</h1>
      <p style="margin:0 0 16px;color:#3a3a44;">${escapeHtml(greeting)}</p>
      <p style="margin:0 0 16px;">Your slot is <strong>held</strong> for ${escapeHtml(input.page.name)} on <strong>${escapeHtml(whenLocal)}</strong>.</p>
      ${input.location ? `<p style="margin:0 0 16px;"><strong>Where:</strong> ${escapeHtml(input.location)}</p>` : ""}
      <p style="margin:0 0 16px;">To lock it in, please pay <strong>${escapeHtml(amount)}</strong> via PayPal.</p>
      ${primaryCta(input.paymentUrl, `Pay ${amount}`)}
      <p style="margin:24px 0 0;font-size:13px;color:#6a6a74;">If we don't see the payment within ${input.page.payment?.holdHours ?? 24} hours, the slot is released automatically.</p>
    `,
  );

  return { subject, text, html };
}

/** Sent at the configured offsets before the meeting. */
export function renderBookingReminderEmail(
  input: EmailRenderInput,
  minutesUntil: number,
): RenderedEmail {
  const whenLocal = formatStartLocal(input.startAt, input.page.timezone);
  const horizonLabel =
    minutesUntil === 10080
      ? "1 week"
      : minutesUntil >= 1440
        ? `${Math.round(minutesUntil / 1440)} day${minutesUntil >= 2880 ? "s" : ""}`
        : minutesUntil < 60
          ? `${minutesUntil} minutes`
          : `${Math.round(minutesUntil / 60)} hour${minutesUntil >= 120 ? "s" : ""}`;

  const subject = `Reminder: ${input.page.name} in ${horizonLabel}`;
  const greeting = `Hi ${input.recipientName?.split(" ")[0] || "there"},`;

  const text = [
    greeting,
    "",
    `Just a heads-up: ${input.page.name} is in ${horizonLabel}.`,
    "",
    `When: ${whenLocal} (${input.page.durationMinutes} min)`,
    input.meetingUrl ? `Join the meeting: ${input.meetingUrl}` : null,
    input.location ? `Where: ${input.location}` : null,
    "",
    input.publicEventUrl
      ? `Need to reschedule or cancel? ${input.publicEventUrl}`
      : null,
    "",
    `Thanks,`,
    input.businessName,
  ]
    .filter((s): s is string => s !== null)
    .join("\n");

  const html = wrapHtml(
    input.businessName,
    input.businessLogoUrl ?? null,
    `
      <h1 style="font-size:20px;margin:0 0 12px;">${escapeHtml(`In ${horizonLabel}: ${input.page.name}`)}</h1>
      <p style="margin:0 0 16px;color:#3a3a44;">${escapeHtml(greeting)}</p>
      <p style="margin:0 0 16px;">${escapeHtml(`Just a heads-up — your ${input.page.name} is in ${horizonLabel}.`)}</p>
      <table role="presentation" style="width:100%;border-collapse:collapse;margin:16px 0 24px;background:#f6f7f9;border-radius:8px;">
        <tr><td style="padding:10px 16px;font-size:14px;"><strong>When:</strong> ${escapeHtml(whenLocal)} (${input.page.durationMinutes} min)</td></tr>
        ${input.location ? `<tr><td style="padding:0 16px 10px;font-size:14px;"><strong>Where:</strong> ${escapeHtml(input.location)}</td></tr>` : ""}
      </table>
      ${input.meetingUrl ? primaryCta(input.meetingUrl, "Join the meeting") : ""}
      ${input.publicEventUrl ? `<p style="margin:16px 0 0;font-size:13px;color:#6a6a74;">Need to reschedule or cancel? <a href="${escapeHtml(input.publicEventUrl)}" style="color:#0F766E;">Manage your booking</a>.</p>` : ""}
    `,
  );

  return { subject, text, html };
}

/** Cancelled by the visitor or the operator. */
export function renderBookingCancelledEmail(
  input: EmailRenderInput,
  reason: "by_visitor" | "by_operator" | "payment_expired",
): RenderedEmail {
  const whenLocal = formatStartLocal(input.startAt, input.page.timezone);
  const subject = `Cancelled: ${input.page.name} on ${whenLocal}`;
  const greeting = `Hi ${input.recipientName?.split(" ")[0] || "there"},`;
  const body =
    reason === "by_visitor"
      ? `Your ${input.page.name} on ${whenLocal} has been cancelled.`
      : reason === "payment_expired"
        ? `We didn't receive your payment in time, so your ${input.page.name} hold on ${whenLocal} has been released. Re-book any time.`
        : `Your ${input.page.name} on ${whenLocal} has been cancelled by the host.`;

  const text = [
    greeting,
    "",
    body,
    "",
    `Thanks,`,
    input.businessName,
  ].join("\n");

  const html = wrapHtml(
    input.businessName,
    input.businessLogoUrl ?? null,
    `
      <h1 style="font-size:20px;margin:0 0 12px;">Booking cancelled</h1>
      <p style="margin:0 0 16px;color:#3a3a44;">${escapeHtml(greeting)}</p>
      <p style="margin:0 0 16px;">${escapeHtml(body)}</p>
    `,
  );

  return { subject, text, html };
}

// Shared HTML scaffolding

function wrapHtml(
  businessName: string,
  logoUrl: string | null,
  body: string,
): string {
  return `<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f6f7f9;margin:0;padding:24px;color:#1a1a22;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">
    <tr><td>
      ${logoUrl ? `<img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(businessName)}" style="max-height:40px;margin-bottom:24px;" />` : `<p style="margin:0 0 24px;font-size:13px;color:#6a6a74;letter-spacing:0.04em;text-transform:uppercase;">${escapeHtml(businessName)}</p>`}
      ${body}
    </td></tr>
  </table>
</body></html>`;
}

function primaryCta(href: string, label: string): string {
  return `<p style="margin:24px 0;">
    <a href="${escapeHtml(href)}" style="display:inline-block;background:#0F766E;color:#ffffff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:500;">${escapeHtml(label)}</a>
  </p>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
