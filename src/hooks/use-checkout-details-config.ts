"use client";
// Hello world
import { CHECKOUT_DETAILS_DEFAULTS, type CheckoutDetailsConfig } from "@/lib/stripe/checkout-details-config";
export interface CheckoutDetailsConfigState extends CheckoutDetailsConfig {
  hydrated: boolean;
}
export function useCheckoutDetailsConfig(): CheckoutDetailsConfigState {
  return { ...CHECKOUT_DETAILS_DEFAULTS, hydrated: true };
}
