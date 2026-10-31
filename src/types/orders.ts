import type { Timestamp, FieldValue } from "firebase/firestore";
import type { ContactAttribution } from "@/types/contacts";
import type { ProductDelivery } from "@/types/products";

/**
 * One doc per attempted card payment through the sub-account's own Stripe
 * (see payments.ts). Top-level with tenancy keys, like `quotes`, because
 * orders have their own list page. An invoice paid by card produces one
 * order and one quote.
 *
 * Money is integer cents. Line items are snapshotted at checkout so product
 * edits never rewrite history; `productId` is only a back-reference.
 */

export type OrderStatus =
  | "pending"
  | "paid"
  | "refunded"
  | "partially_refunded"
  | "failed";

export type OrderSource =
  | "checkout_page"
  | "quote"
  | "booking_deposit"
  | "community"
  // Express buy link (website Buy buttons or a shared link).
  | "product_link";

/** Where on the website the buyer clicked Buy. Display only, never trusted. */
export interface OrderWebsiteRef {
  siteId: string | null;
  page: string | null;
}

/** A line's product.delivery, snapshotted when the session was created. */
export interface OrderDeliverySnapshot {
  productId: string;
  delivery: Exclude<ProductDelivery, { type: "none" }>;
}

export interface OrderDeliveryStatus {
  /** "failed" when any delivery on the order failed. */
  state: "done" | "failed";
  error: string | null;
  /** Epoch ms. */
  at: number;
}

export interface OrderConfirmationStatus {
  state: "sent" | "failed";
  error: string | null;
  /** Epoch ms. */
  at: number;
}

export interface OrderLineItem {
  /** Null for ad-hoc items with no catalog entry. */
  productId: string | null;
  name: string;
  description: string;
  unitPriceCents: number;
  quantity: number;
  /** Line came from an order bump; drives bump take-rate reporting. */
  isBump: boolean;
}

export interface Order {
  id: string;

  agencyId: string;
  subAccountId: string;

  contactId: string | null;
  checkoutPageId: string | null;
  // Source references: each is set only for its matching `source`, else null.
  // Kept as separate fields (not a generic sourceRefId) so they stay unambiguous.
  quoteId: string | null;
  eventId: string | null;
  /** Purchases nest under a group, so both ids are needed. */
  communityGroupId: string | null;
  purchaseId: string | null;
  source: OrderSource;

  status: OrderStatus;
  /** ISO 4217, lowercase like Stripe. */
  currency: string;
  lineItems: OrderLineItem[];
  subtotalCents: number;
  totalCents: number;
  refundedCents: number;

  // Always the client's own Stripe account.
  stripeCheckoutSessionId: string;
  stripePaymentIntentId: string | null;
  /** False for test-mode keys, so play money stays out of reports. */
  livemode: boolean;

  /** As Stripe saw them. Kept even without a contact so the order stays actionable. */
  buyerEmail: string | null;
  buyerName: string | null;

  /** First-touch attribution copied at creation so later contact edits can't rewrite revenue. */
  attribution: ContactAttribution | null;

  // Optional, absent on every order created before Sell Online.
  /** Set for source "product_link". */
  productLinkProductId?: string | null;
  websiteRef?: OrderWebsiteRef | null;
  /** What to deliver once paid; absent/empty = nothing. */
  deliveries?: OrderDeliverySnapshot[];
  /** Roll-up of the order's entitlements, for the Payments report. */
  deliveryStatus?: OrderDeliveryStatus | null;
  /** The plain-text order confirmation sent to the buyer (buy links and checkout pages only). */
  confirmationEmail?: OrderConfirmationStatus | null;

  createdAt: Timestamp | FieldValue | null;
  paidAt: Timestamp | FieldValue | null;
  updatedAt: Timestamp | FieldValue | null;
}

/** Shared by the service, checkout page and reporting so totals can't drift. */
export function computeOrderSubtotalCents(items: OrderLineItem[]): number {
  return items.reduce(
    (sum, li) => sum + li.unitPriceCents * li.quantity,
    0,
  );
}

/** The reconciler must never move an order out of these. */
export function isOrderTerminal(status: OrderStatus): boolean {
  return status === "refunded" || status === "failed";
}
