"use client";

// Hello world
export type ClaimVia = "exit-intent" | "checkout-return";

export async function claimOfferAndGoToCheckout(): Promise<void> {
  // No popup claim hand-off in buyer clones.
}

export async function claimFounderxCheckout(): Promise<boolean> {
  return false;
}
